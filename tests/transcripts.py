"""Replay a recorded adapter transcript as the replies of a car, for tests."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from obd_read.elm import isotp_reassemble

FIXTURES = Path(__file__).parent / "fixtures"

# One request payload (upper-case hex) mapped to the (sender, message) pairs the car answered with.
Replies = dict[str, list[tuple[int, bytes]]]


def load_replies(*names: str) -> Replies:
    """Read transcripts written by `Transcript` and collect each diagnostic request's replies.

    Lines sent to the adapter start with `>` and lines received with `<`. Adapter set-up commands and requests that drew no data are skipped.
    """
    replies: Replies = {}
    for name in names:
        command: str | None = None
        frames: list[tuple[int, bytes]] = []

        def finish(command: str | None, frames: list[tuple[int, bytes]]) -> None:
            if command is not None and not command.startswith(("AT", "ST")) and frames:
                messages = isotp_reassemble(frames)
                replies[command] = [
                    (sender, m) for sender, found in messages.items() for m in found
                ]

        for line in (FIXTURES / name).read_text().splitlines():
            _, direction, text = line.split(" ", 2)
            if direction == ">":
                finish(command, frames)
                command, frames = text, []
            elif len(text) > 3 and text[:3].isalnum() and text not in ("NO DATA", "ELM327 v1.5"):
                try:
                    frames.append((int(text[:3], 16), bytes.fromhex(text[3:])))
                except ValueError:
                    continue
        finish(command, frames)
    return replies


def responder(replies: Replies) -> Callable[[bytes], list[tuple[int, bytes]]]:
    """A functional-address responder that answers from recorded replies and is silent otherwise."""
    return lambda request: replies.get(request.hex().upper(), [])
