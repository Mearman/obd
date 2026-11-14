"""An in-memory CAN bus with ISO-TP speaking control units, for raw CAN link tests."""

from __future__ import annotations

from collections.abc import Callable

from obd_read.isotp import Receiver, flow_control_frame, pad, segment
from obd_read.transport import TransportTimeout
from obd_read.transport.can import CanFrame

Responder = Callable[[bytes], list[tuple[int, bytes]]]

FUNCTIONAL_11 = 0x7DF


class FakeCanLink:
    """A CanLink whose bus holds control units that answer requests, honouring flow control."""

    def __init__(
        self, responders: dict[int, Responder], response_ids: dict[int, int] | None = None
    ) -> None:
        self.responders = responders
        # The identifier each unit sends flow control from; a unit not listed uses the request identifier plus 8.
        self.response_ids = response_ids or {}
        self.sent: list[CanFrame] = []
        self.configured: list[tuple[int, bool]] = []
        self.opened = False
        self.closed = False
        self._queue: list[CanFrame] = []
        self._receivers: dict[int, Receiver] = {}
        # Consecutive frames each unit holds back, with the request identifier whose flow control releases them.
        self._held: dict[int, tuple[int, list[CanFrame]]] = {}

    async def open(self) -> None:
        self.opened = True

    async def configure(self, bitrate: int, listen_only: bool) -> None:
        self.configured.append((bitrate, listen_only))

    async def close(self) -> None:
        self.closed = True

    async def receive(self, timeout: float) -> CanFrame:
        if not self._queue:
            raise TransportTimeout("nothing on the fake bus")
        return self._queue.pop(0)

    async def send(self, frame: CanFrame) -> None:
        self.sent.append(frame)
        kind = frame.data[0] >> 4
        if kind == 3:
            # Flow control from the tester releases the consecutive frames the unit held back.
            for sender in [*self._held]:
                request_id, held = self._held[sender]
                if request_id == frame.can_id:
                    self._queue.extend(held)
                    del self._held[sender]
            return
        receiver = self._receivers.setdefault(frame.can_id, Receiver())
        received = receiver.feed(frame.can_id, frame.data)
        if received.send_flow_control:
            sender = self.response_ids.get(frame.can_id, frame.can_id + 8)
            self._queue.append(CanFrame(sender, flow_control_frame(), frame.extended))
        if received.message is None:
            return
        targets = (
            list(self.responders)
            if frame.can_id == FUNCTIONAL_11
            else [frame.can_id] * (frame.can_id in self.responders)
        )
        for target in targets:
            for sender, payload in self.responders[target](received.message):
                frames = [CanFrame(sender, data, frame.extended) for data in segment(payload)]
                self._queue.append(frames[0])
                if len(frames) > 1:
                    self._held[sender] = (target, frames[1:])

    def inject(self, can_id: int, data: bytes, extended: bool = False) -> None:
        """Put a frame on the bus as if another node sent it."""
        self._queue.append(CanFrame(can_id, pad(data), extended))
