"""The `obd-read` command line."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from . import obd
from .diag import NegativeResponse
from .elm import AdapterInfo, Elm, ElmError, Transcript
from .guard import GuardError
from .operations import (
    ClearRefused,
    UnitReport,
    clear_unit,
    document,
    read_unit,
    render_markdown,
    scan,
    unit_session,
)
from .profile import Profile, ProfileError, builtin_profiles, load_profile
from .transport import Transport, TransportError, open_transport

Printer = Callable[[str], None]
TransportFactory = Callable[[str], Transport]


@asynccontextmanager
async def connected(
    url: str, log: Path | None, factory: TransportFactory
) -> AsyncIterator[tuple[Elm, AdapterInfo]]:
    """Open the adapter, initialise it, and close the link on the way out."""
    transport = factory(url)
    await transport.open()
    try:
        elm = Elm(transport, Transcript(log))
        yield elm, await elm.initialise()
    finally:
        await transport.close()


def print_unit(report: UnitReport, out: Printer) -> None:
    """Print one unit's report as indented plain text."""
    state = "answered" if report.answered else "no answer"
    out(f"{report.unit} ({report.request_id} -> {report.response_id}): {state}")
    for label, value in report.identification.items():
        out(f"  {label}: {value['hex']}  {value['text']}")
    if report.faults is not None:
        out(f"  fault codes: {len(report.faults)}")
        for fault in report.faults:
            out(f"    {fault['code']}  status {fault['status']}")
            if fault["code"] in report.freeze_frames:
                out(f"      freeze frame: {report.freeze_frames[fault['code']]}")
    for note in report.notes:
        out(f"  note: {note}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="obd-read",
        description="Read vehicle diagnostics through ELM327-style adapters.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    def car_command(name: str, summary: str, *, profile: bool = True) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=summary, description=summary)
        sub.add_argument(
            "--adapter",
            required=True,
            help="adapter URL: ble://<name or address>, serial://<device>, tcp://<host>:<port>",
        )
        sub.add_argument("--log", type=Path, help="append the full adapter transcript to this file")
        if profile:
            sub.add_argument(
                "--profile",
                required=True,
                help=f"profile name ({', '.join(builtin_profiles())}) or path to a .toml file",
            )
        return sub

    adapters = commands.add_parser("adapters", help="list Bluetooth LE devices and serial ports")
    adapters.add_argument(
        "--inspect", metavar="NAME", help="show one Bluetooth LE device's services"
    )
    adapters.add_argument("--timeout", type=float, default=8.0, help="scan time in seconds")

    car_command("probe", "ask every unit in the profile to identify itself")
    car_command("ident", "read one unit's identification").add_argument("unit")
    car_command("faults", "read one unit's stored fault codes").add_argument("unit")
    car_command("freeze", "read the freeze frame stored with each fault code").add_argument("unit")

    scan_command = car_command("scan", "read identification and fault codes from every unit")
    scan_command.add_argument("--output", type=Path, help="write <output>.json and <output>.md")
    scan_command.add_argument("--freeze", action="store_true", help="also read freeze frames")

    obd_command = car_command("obd", "legislated OBD-II reads; needs no profile", profile=False)
    obd_command.add_argument("--id-bits", type=int, choices=(11, 29), default=11)
    obd_command.add_argument("--bitrate", type=int, choices=(250000, 500000), default=500000)

    request = car_command("request", "send one read-only request, given as hexadecimal bytes")
    request.add_argument("unit")
    request.add_argument("hex", help="request bytes, for example 1A86")

    clear = car_command("clear", "save, then erase, one unit's stored fault codes")
    clear.add_argument("unit")
    clear.add_argument("--save", type=Path, required=True, help="new file for the snapshot")
    clear.add_argument("--yes", action="store_true", help="do not ask before clearing")
    return parser


async def list_adapters(args: argparse.Namespace, out: Printer) -> int:
    from bleak import BleakClient, BleakScanner
    from serial.tools import list_ports

    from .transport.ble import describe_services, find_device

    if args.inspect:
        device = await find_device(args.inspect, args.timeout)
        async with BleakClient(device) as client:
            out(f"{device.name or '(no name)'}  {device.address}")
            for item in describe_services(client):
                out(f"  service {item.service}")
                out(f"    characteristic {item.uuid}  {', '.join(item.properties)}")
        return 0
    out("Bluetooth LE devices:")
    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)
    for device, advertisement in sorted(found.values(), key=lambda pair: -pair[1].rssi):
        name = advertisement.local_name or device.name or "(no name)"
        out(f"  {name}  {device.address}  signal {advertisement.rssi} dBm")
    out("Serial ports:")
    for port in sorted(list_ports.comports(), key=lambda p: p.device):
        out(f"  {port.device}  {port.description}")
    return 0


async def obd_command(elm: Elm, args: argparse.Namespace, out: Printer) -> int:
    await elm.select_can(args.id_bits, args.bitrate)
    await elm.address_functional(obd.FUNCTIONAL_ID[args.id_bits])
    out(f"VIN: {await obd.vin(elm) or 'not reported'}")
    states = await obd.readiness(elm)
    if not states:
        out("no unit answered the readiness request")
    for sender, state in states.items():
        lamp = "on" if state.lamp_on else "off"
        out(f"unit {sender:X}: warning lamp {lamp}, {state.code_count} stored codes")
    kinds = (
        ("stored", obd.STORED_CODES),
        ("pending", obd.PENDING_CODES),
        ("permanent", obd.PERMANENT_CODES),
    )
    for label, mode in kinds:
        try:
            found = await obd.codes(elm, mode)
        except ElmError as error:
            out(f"{label} codes: not read ({error})")
            continue
        for sender, codes in found.items():
            out(f"{label} codes from {sender:X}: {', '.join(codes) or 'none'}")
    for name, value in (await obd.live(elm)).items():
        out(f"{name}: {value}")
    return 0


async def profile_command(
    elm: Elm,
    adapter: AdapterInfo,
    profile: Profile,
    args: argparse.Namespace,
    out: Printer,
    ask: Callable[[str], str],
) -> int:
    await elm.select_can(profile.id_bits, profile.bitrate)
    if profile.status != "confirmed":
        out(f"profile {profile.name}: address table is {profile.status}")

    if args.command in ("probe", "scan"):
        with_faults = args.command == "scan"
        reports = await scan(
            elm, profile, faults=with_faults, freeze=with_faults and bool(args.freeze)
        )
        for report in reports:
            print_unit(report, out)
        answered = sum(report.answered for report in reports)
        out(f"{answered} of {len(reports)} units answered")
        if with_faults and args.output is not None:
            saved = document(profile, adapter, reports, list(elm.transcript.entries))
            json_path = args.output.with_suffix(".json")
            markdown_path = args.output.with_suffix(".md")
            json_path.write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")
            markdown_path.write_text(
                render_markdown(profile, str(saved["taken"]), reports), encoding="utf-8"
            )
            out(f"wrote {json_path} and {markdown_path}")
        return 0

    unit = profile.unit(args.unit)
    if args.command in ("ident", "faults", "freeze"):
        report = await read_unit(
            elm,
            profile,
            unit,
            faults=args.command != "ident",
            freeze=args.command == "freeze",
        )
        print_unit(report, out)
        return 0 if report.answered else 1

    if args.command == "request":
        try:
            payload = bytes.fromhex(args.hex)
        except ValueError as error:
            raise GuardError(f"request is not hexadecimal bytes: {args.hex!r}") from error
        await elm.address_unit(unit.request_id, unit.response_id)
        reply = await unit_session(elm, profile, unit).request(payload)
        out(reply.hex().upper())
        return 0

    def confirm(before: UnitReport) -> bool:
        print_unit(before, out)
        out(f"snapshot saved to {args.save}")
        if args.yes:
            return True
        return ask(f"Erase these fault codes from {unit.name}? Type yes to continue: ") == "yes"

    outcome = await clear_unit(elm, profile, adapter, unit, args.save, confirm)
    if not outcome.cleared or outcome.after is None:
        out("nothing cleared")
        return 1
    out("cleared; reading the unit again:")
    print_unit(outcome.after, out)
    return 0


async def run(
    argv: list[str],
    out: Printer = print,
    ask: Callable[[str], str] = input,
    factory: TransportFactory = open_transport,
) -> int:
    """Run one command and return its exit status."""
    args = build_parser().parse_args(argv)
    try:
        if args.command == "adapters":
            return await list_adapters(args, out)
        profile = None if args.command == "obd" else load_profile(args.profile)
        async with connected(args.adapter, args.log, factory) as (elm, adapter):
            out(f"adapter: {adapter.identity}, battery {adapter.voltage or 'not reported'}")
            if profile is None:
                return await obd_command(elm, args, out)
            return await profile_command(elm, adapter, profile, args, out, ask)
    except (
        GuardError,
        ProfileError,
        TransportError,
        ElmError,
        NegativeResponse,
        ClearRefused,
        ValueError,
    ) as error:
        out(f"error: {error}")
        return 1


def main() -> None:
    sys.exit(asyncio.run(run(sys.argv[1:])))
