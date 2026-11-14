import pytest

from obd_read.elm import Elm
from obd_read.guard import DiagProtocol, permit
from obd_read.transport import TransportError, TransportTimeout, open_transport, parse_adapter_url
from obd_read.transport.ble import GattCharacteristic, pick_data_channel
from obd_read.transport.tcp import TcpTransport

from .fake_elm import FakeElmCore, KwpEcu, serve


def test_adapter_urls() -> None:
    ble = parse_adapter_url("ble://vLinker%20FD?service=18f0&notify=2af0")
    assert (ble.scheme, ble.target) == ("ble", "vLinker FD")
    assert ble.params == {"service": "18f0", "notify": "2af0"}
    assert parse_adapter_url("ble://AA:BB:CC:DD:EE:FF").target == "AA:BB:CC:DD:EE:FF"
    assert parse_adapter_url("serial:///dev/tty.usbserial-1").target == "/dev/tty.usbserial-1"
    assert parse_adapter_url("tcp://192.168.80.1:35000").target == "192.168.80.1:35000"


@pytest.mark.parametrize("url", ["vLinker", "usb://x", "ble://", "tcp://hostonly", "tcp://h:port"])
def test_bad_adapter_urls_are_refused(url: str) -> None:
    with pytest.raises(ValueError):
        open_transport(url)


async def test_tcp_transport_end_to_end() -> None:
    core = FakeElmCore({0x784: KwpEcu(0x785, [])})
    server = await serve(core)
    port = server.sockets[0].getsockname()[1]
    transport = TcpTransport("127.0.0.1", port)
    await transport.open()
    try:
        elm = Elm(transport)
        await elm.initialise()
        await elm.select_can(11, 500_000)
        await elm.address_unit(0x784, 0x785)
        replies = await elm.request(permit(DiagProtocol.KWP2000, bytes.fromhex("1092")))
        assert replies == {0x785: [bytes.fromhex("5092")]}
        with pytest.raises(TransportTimeout):
            await transport.read(0.05)
    finally:
        await transport.close()
        server.close()
        await server.wait_closed()


async def test_tcp_connection_refused_is_a_transport_error() -> None:
    server = await serve(FakeElmCore({}))
    port = server.sockets[0].getsockname()[1]
    server.close()
    await server.wait_closed()
    with pytest.raises(TransportError, match="cannot connect"):
        await TcpTransport("127.0.0.1", port).open()


GENERIC = "00001800-0000-1000-8000-00805f9b34fb"
DATA = "000018f0-0000-1000-8000-00805f9b34fb"
OTHER = "0000fff0-0000-1000-8000-00805f9b34fb"


def test_ble_picker_skips_standard_services() -> None:
    channel = pick_data_channel(
        [
            GattCharacteristic(GENERIC, "00002a00", ("read", "write", "notify")),
            GattCharacteristic(DATA, "00002af0", ("notify",)),
            GattCharacteristic(DATA, "00002af1", ("write-without-response",)),
        ]
    )
    assert (channel.notify, channel.write, channel.write_with_response) == (
        "00002af0",
        "00002af1",
        False,
    )


def test_ble_picker_honours_overrides() -> None:
    characteristics = [
        GattCharacteristic(DATA, "00002af0", ("notify",)),
        GattCharacteristic(DATA, "00002af1", ("write",)),
        GattCharacteristic(OTHER, "0000fff1", ("notify",)),
        GattCharacteristic(OTHER, "0000fff2", ("write",)),
    ]
    channel = pick_data_channel(characteristics, service="0000fff0")
    assert (channel.notify, channel.write, channel.write_with_response) == (
        "0000fff1",
        "0000fff2",
        True,
    )


def test_ble_picker_with_no_usable_service_says_what_to_do() -> None:
    with pytest.raises(TransportError, match="adapters --inspect"):
        pick_data_channel([GattCharacteristic(DATA, "00002af0", ("notify",))])
