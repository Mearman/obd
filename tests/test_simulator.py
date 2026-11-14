import asyncio
import json
from pathlib import Path

import pytest

from obd_read.cli import run
from obd_read.profile import load_profile
from obd_read.simulator import start_simulator

from .test_profile import MINIMAL


async def drive(profile_name: str, *argv: str, answer: str = "") -> tuple[int, str]:
    """Run one command against a freshly started simulator, over a real TCP connection."""
    server = await start_simulator(load_profile(profile_name), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    lines: list[str] = []
    try:
        status = await run(
            [*argv, "--adapter", f"tcp://127.0.0.1:{port}"], lines.append, lambda _p: answer
        )
    finally:
        server.close()
        await server.wait_closed()
    return status, "\n".join(lines)


async def test_every_unit_of_a_kwp_profile_answers_over_tcp() -> None:
    count = len(load_profile("mercedes-w211").units)
    status, output = await drive("mercedes-w211", "probe", "--profile", "mercedes-w211")
    assert status == 0
    assert f"{count} of {count} units answered" in output


async def test_faults_and_freeze_frames_read_from_the_simulated_car() -> None:
    status, output = await drive("mercedes-w211", "freeze", "esp", "--profile", "mercedes-w211")
    assert status == 0
    assert "1234  status 20" in output
    assert "freeze frame:" in output


async def test_a_uds_profile_is_simulated_too(tmp_path: Path) -> None:
    profile = tmp_path / "uds-car.toml"
    profile.write_text(MINIMAL)
    status, output = await drive(str(profile), "scan", "--profile", str(profile), "--freeze")
    assert status == 0
    assert "VIN: " in output
    assert "C12345  status 08" in output
    assert "1 of 1 units answered" in output


async def test_the_simulated_car_can_be_cleared_and_each_connection_starts_fresh(
    tmp_path: Path,
) -> None:
    server = await start_simulator(load_profile("mercedes-w211"), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    args = ["--adapter", f"tcp://127.0.0.1:{port}", "--profile", "mercedes-w211"]
    save = tmp_path / "before.json"
    lines: list[str] = []
    try:
        assert await run(["clear", "esp", *args, "--save", str(save), "--yes"], lines.append) == 0
        assert lines[-1] == "  fault codes: 0"
        assert json.loads(save.read_text())["units"][0]["faults"] == [
            {"code": "1234", "status": "20"}
        ]
        lines.clear()
        assert await run(["faults", "esp", *args], lines.append) == 0
        assert "fault codes: 1" in "\n".join(lines)
    finally:
        server.close()
        await server.wait_closed()


async def test_the_simulator_answers_legislated_obd_requests() -> None:
    status, output = await drive("mercedes-w211", "obd")
    assert status == 0
    assert "VIN: SIMULATEDCAR00001" in output
    assert "stored codes from 7E8: P0420" in output


async def test_the_simulate_command_announces_where_it_listens() -> None:
    lines: list[str] = []
    task = asyncio.ensure_future(
        run(["simulate", "--profile", "mercedes-w211", "--port", "0"], lines.append)
    )
    for _ in range(100):
        if lines:
            break
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert lines[0].startswith("simulating mercedes-w211 (")
    assert "on tcp://127.0.0.1:" in lines[0]
