"""A CSV file written one row at a time, so a run that is interrupted keeps what it logged."""

from __future__ import annotations

import csv
from collections.abc import Sequence
from pathlib import Path
from types import TracebackType
from typing import IO, Self


class CsvLog:
    """A new CSV file with a header row. Each row is flushed to disk as it is written.

    Raises ValueError when the file already exists: an earlier log is evidence and is never overwritten.
    """

    def __init__(self, path: Path, header: Sequence[str]) -> None:
        if path.exists():
            raise ValueError(f"{path} already exists; choose a new file for the log")
        self._file: IO[str] = path.open("x", encoding="utf-8", newline="")
        self._writer = csv.writer(self._file)
        self.write(header)

    def write(self, row: Sequence[str]) -> None:
        """Append one row and flush it."""
        self._writer.writerow(row)
        self._file.flush()

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
