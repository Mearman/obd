"""Rebuild `src/obd_read/data/obdex-generic.tsv` from a downloaded OBDex `generic.min.json`.

Usage: python scripts/vendor_obdex.py generic.min.json <commit> <retrieved-date> > src/obd_read/data/obdex-generic.tsv

Only the English title of each code is kept, with the spaced dashes some titles use written as a plain hyphen. The bundle is published at
https://foerbsnavi.github.io/OBDex/generic.min.json and the data is CC0 1.0.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(bundle: Path, commit: str, retrieved: str) -> None:
    entries = json.loads(bundle.read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise SystemExit("the bundle is not a list of codes")
    titles: dict[str, str] = {}
    for entry in entries:
        code, title = entry["code"], entry["title"]["en"]
        if (
            not isinstance(code, str)
            or not isinstance(title, str)
            or "\t" in title
            or "\n" in title
        ):
            raise SystemExit(f"unusable entry for {code!r}")
        titles[code] = title.replace(" \u2014 ", " - ").replace(" \u2013 ", " - ")
    print(
        "# Generic OBD-II fault-code titles (English), from OBDex: https://github.com/foerbsnavi/OBDex"
    )
    print("# Licence of the data: CC0 1.0 (LICENSE-DATA in that repository).")
    print(
        f"# Source: https://foerbsnavi.github.io/OBDex/generic.min.json retrieved {retrieved}; repository head then {commit}."
    )
    print(
        "# Rebuild with scripts/vendor_obdex.py. One code and its title per line, separated by a tab."
    )
    for code in sorted(titles):
        print(f"{code}\t{titles[code]}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
