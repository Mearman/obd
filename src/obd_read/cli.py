"""The `obd-read` command line."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from . import legislated, monitor, obd
from .actuate import ActuationError, actuate_command
from .actuate import add_command as add_actuate_command
from .battery import battery_command
from .diag import NegativeResponse
from .discovery import discover_command
from .elm import MAX_SINGLE_FRAME, AdapterInfo, Elm, ElmError, Transcript
from .guard import GuardError
from .kline import KLineElm, select_bus
from .live import add_source_options, live_command
from .obd_clear import clear_codes_command
from .offline import OFFLINE_COMMANDS, add_offline_commands, run_offline
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
from .profile import (
    DEFAULT_TESTER,
    KLINE_SCHEMES,
    KLineBus,
    Profile,
    ProfileError,
    builtin_profiles,
    load_profile,
)
from .profile_check import profile_check_command
from .simulator import simulate_command
from .transport import Transport, TransportError, open_transport
from .transport.rawcan import RawCanTransport
from .writes import WRITE_COMMANDS, WriteRefused, write_command
from .writes import add_commands as add_write_commands

Printer = Callable[[str], None]
TransportFactory = Callable[[str], Transport]


@asynccontextmanager
async def connected(
    url: str, log: Path | None, factory: TransportFactory, kline: bool = False
) -> AsyncIterator[tuple[Elm, AdapterInfo]]:
    """Open the adapter, initialise it, and close the link on the way out.

    `kline` selects the session class that reads K-line replies rather than CAN frames.
    """
    transport = factory(url)
    await transport.open()
    try:
        limit = (
            transport.max_request if isinstance(transport, RawCanTransport) else MAX_SINGLE_FRAME
        )
        elm = (KLineElm if kline else Elm)(transport, Transcript(log), limit)
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

    monitor.add_arguments(commands)
    adapters = commands.add_parser("adapters", help="list Bluetooth LE devices and serial ports")
    adapters.add_argument(
        "--inspect", metavar="NAME", help="show one Bluetooth LE device's services"
    )
    adapters.add_argument("--timeout", type=float, default=8.0, help="scan time in seconds")

    profile_group = commands.add_parser("profile", help="work with vehicle profiles")
    profile_actions = profile_group.add_subparsers(dest="action", required=True)
    check = profile_actions.add_parser(
        "check", help="validate profile files without connecting to anything"
    )
    check.add_argument("targets", nargs="+", metavar="PROFILE", help="a profile name or .toml path")

    simulate = commands.add_parser(
        "simulate",
        help="serve a scripted adapter and car over TCP, for use without a car",
        description="Serve a scripted ELM327 adapter and car over TCP, so the tool and a profile can be tried without a car. Nothing is connected to.",
    )
    simulate.add_argument("--profile", required=True, help="profile whose units the car has")
    simulate.add_argument("--host", default="127.0.0.1", help="address to listen on")
    simulate.add_argument("--port", type=int, default=35000, help="port to listen on (0 picks one)")

    car_command("probe", "ask every unit in the profile to identify itself")
    car_command("ident", "read one unit's identification").add_argument("unit")
    car_command("faults", "read one unit's stored fault codes").add_argument("unit")
    car_command("freeze", "read the freeze frame stored with each fault code").add_argument("unit")

    scan_command = car_command("scan", "read identification and fault codes from every unit")
    scan_command.add_argument("--output", type=Path, help="write <output>.json and <output>.md")
    scan_command.add_argument("--freeze", action="store_true", help="also read freeze frames")

    obd_command = car_command("obd", "legislated OBD-II reads; needs no profile", profile=False)
    obd_command.add_argument("--id-bits", type=int, choices=(11, 29), default=11)
    obd_command.add_argument("--bitrate", type=int, default=500000, help="CAN bit rate in bit/s")
    obd_command.add_argument(
        "--kline",
        choices=tuple(KLINE_SCHEMES),
        help="read over K-line with this initialisation instead of CAN",
    )

    live = car_command(
        "live",
        "read named live values once or repeatedly, optionally logging to CSV",
        profile=False,
    )
    add_source_options(live)
    live.add_argument("--list", action="store_true", help="list the value names and stop")
    live.add_argument("--count", type=int, default=1, help="how many samples to take")
    live.add_argument("--interval", type=float, default=1.0, help="seconds between samples")
    live.add_argument("--csv", type=Path, help="write each sample to this new CSV file")

    battery = car_command(
        "battery",
        "log the adapter's voltage reading at a fixed interval; needs no profile or car bus",
        profile=False,
    )
    battery.add_argument("--duration", type=float, default=60.0, help="seconds to keep sampling")
    battery.add_argument("--interval", type=float, default=0.25, help="seconds between samples")
    battery.add_argument(
        "--precision", type=int, help="decimals to ask for from an adapter that has STVR"
    )
    battery.add_argument("--csv", type=Path, help="write each sample to this new CSV file")

    discover = car_command(
        "discover",
        "sweep CAN request identifiers for units that answer a session request",
        profile=False,
    )
    discover.add_argument("--protocol", choices=("kwp2000", "uds"), required=True)
    discover.add_argument("--session", type=lambda text: int(text, 0), help="default per protocol")
    discover.add_argument("--bitrate", type=int, choices=(250000, 500000), default=500000)
    discover.add_argument("--first", type=lambda text: int(text, 0), default=0x700)
    discover.add_argument("--last", type=lambda text: int(text, 0), default=0x7FF)
    discover.add_argument("--output", type=Path, help="write a draft profile to this new file")
    discover.add_argument("--name", default="discovered", help="name for the draft profile")
    clear_codes = car_command(
        "clear-codes",
        "save, then erase, every emissions unit's codes; needs no profile",
        profile=False,
    )
    clear_codes.add_argument("--id-bits", type=int, choices=(11, 29), default=11)
    clear_codes.add_argument("--bitrate", type=int, choices=(250000, 500000), default=500000)
    clear_codes.add_argument("--save", type=Path, required=True, help="new file for the snapshot")
    clear_codes.add_argument("--yes", action="store_true", help="do not ask before clearing")

    request = car_command("request", "send one read-only request, given as hexadecimal bytes")
    request.add_argument("unit")
    request.add_argument("hex", help="request bytes, for example 1A86")

    clear = car_command("clear", "save, then erase, one unit's stored fault codes")
    clear.add_argument("unit")
    clear.add_argument("--save", type=Path, required=True, help="new file for the snapshot")
    clear.add_argument("--yes", action="store_true", help="do not ask before clearing")
    add_offline_commands(commands)
    add_write_commands(car_command)
    add_actuate_command(car_command)
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
    if isinstance(elm, KLineElm):
        await elm.select_kline(KLineBus(args.kline, DEFAULT_TESTER, KLINE_SCHEMES[args.kline][1]))
        await elm.address_functional(0)
    else:
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
    await legislated.report(elm, out)
    for sender, frame in (await obd.freeze_frame(elm)).items():
        out(f"freeze frame from {sender:X}: {frame.code or 'no code'}")
        for name, value in frame.values.items():
            out(f"  {name}: {value}")
    for sender, monitors in (await obd.misfire_counts(elm)).items():
        out(
            f"misfire counts from {sender:X} "
            "(cylinder order follows the monitor order and is unconfirmed):"
        )
        for counts in monitors:
            where = (
                "engine"
                if counts.monitor == obd.MISFIRE_GENERAL
                else (f"cylinder {counts.monitor - obd.MISFIRE_FIRST_CYLINDER + 1}")
            )
            average = (
                "not reported"
                if counts.average_last_ten_cycles is None
                else counts.average_last_ten_cycles
            )
            latest = "not reported" if counts.last_cycle is None else counts.last_cycle
            out(f"  {where}: last cycle {latest}, average of last ten cycles {average}")
    return 0


async def profile_command(
    elm: Elm,
    adapter: AdapterInfo,
    profile: Profile,
    args: argparse.Namespace,
    out: Printer,
    ask: Callable[[str], str],
) -> int:
    await select_bus(elm, profile)
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
    if args.command in WRITE_COMMANDS:
        return await write_command(elm, adapter, profile, unit, args, out, ask)
    if args.command == "actuate":
        return await actuate_command(elm, profile, unit, args, out, ask)
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
        if args.command == "monitor":
            return await monitor.run_monitor(args, out, factory)
        if args.command == "simulate":
            return await simulate_command(args, out)
        if args.command == "profile":
            return profile_check_command(args, out)
        if args.command in OFFLINE_COMMANDS:
            return run_offline(args, out)
        if args.command == "live":
            profile = load_profile(args.profile) if args.profile else None
        elif args.command in ("obd", "discover", "clear-codes", "battery"):
            profile = None
        else:
            profile = load_profile(args.profile)
        kline = (args.command == "obd" and bool(args.kline)) or (
            profile is not None and isinstance(profile.bus, KLineBus)
        )
        async with connected(args.adapter, args.log, factory, kline) as (elm, adapter):
            out(f"adapter: {adapter.identity}, battery {adapter.voltage or 'not reported'}")
            out(f"STN extensions: {adapter.stn_identity or 'none (plain ELM327 command set)'}")
            if args.command == "live":
                return await live_command(elm, profile, args, out)
            if args.command == "battery":
                return await battery_command(elm, adapter, args, out)
            if profile is None and args.command == "discover":
                return await discover_command(elm, args, out)
            if args.command == "clear-codes":
                return await clear_codes_command(elm, adapter, args, out, ask)
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
        WriteRefused,
        ActuationError,
        ValueError,
    ) as error:
        out(f"error: {error}")
        return 1


def main() -> None:
    try:
        sys.exit(asyncio.run(run(sys.argv[1:])))
    except KeyboardInterrupt:
        sys.exit(130)
