import { describe, expect, it } from "vitest";
import { TransportError, TransportTimeout, parseAdapterUrl } from "../src/core/index.js";
import {
  BleTransport,
  MIN_WRITE_SIZE,
  bleTransportFor,
  canonicalUuid,
  matchesBleTarget,
  pickDataChannel,
  type BleAdvertisement,
  type GattCharacteristic,
} from "../src/node/ble.js";
import { FakeCentral, FakePeripheral } from "./helpers/fake-ble.js";

const GENERIC = "00001800-0000-1000-8000-00805f9b34fb";
const DATA = "000018f0-0000-1000-8000-00805f9b34fb";
const OTHER = "0000fff0-0000-1000-8000-00805f9b34fb";

describe("pickDataChannel", () => {
  it("skips standard services", () => {
    const channel = pickDataChannel([
      { service: GENERIC, uuid: "00002a00", properties: ["read", "write", "notify"] },
      { service: DATA, uuid: "00002af0", properties: ["notify"] },
      { service: DATA, uuid: "00002af1", properties: ["write-without-response"] },
    ]);
    expect(channel).toEqual({ notify: "00002af0", write: "00002af1", writeWithResponse: false });
  });

  const both: GattCharacteristic[] = [
    { service: DATA, uuid: "00002af0", properties: ["notify"] },
    { service: DATA, uuid: "00002af1", properties: ["write"] },
    { service: OTHER, uuid: "0000fff1", properties: ["notify"] },
    { service: OTHER, uuid: "0000fff2", properties: ["write"] },
  ];

  it("takes the first service with both when there are no overrides", () => {
    expect(pickDataChannel(both)).toEqual({
      notify: "00002af0",
      write: "00002af1",
      writeWithResponse: true,
    });
  });

  it("honours the service override, by prefix or by 16-bit form", () => {
    const expected = { notify: "0000fff1", write: "0000fff2", writeWithResponse: true };
    expect(pickDataChannel(both, { service: "0000fff0" })).toEqual(expected);
    expect(pickDataChannel(both, { service: "FFF0" })).toEqual(expected);
  });

  it("honours notify and write overrides", () => {
    const characteristics: GattCharacteristic[] = [
      { service: DATA, uuid: "00002af0", properties: ["notify"] },
      { service: DATA, uuid: "00002af2", properties: ["indicate"] },
      { service: DATA, uuid: "00002af1", properties: ["write"] },
      { service: DATA, uuid: "00002af3", properties: ["write-without-response"] },
    ];
    expect(pickDataChannel(characteristics, { notify: "00002af2", write: "00002af3" })).toEqual({
      notify: "00002af2",
      write: "00002af3",
      writeWithResponse: false,
    });
  });

  it("with no usable service says what to do", () => {
    const error = (() => {
      try {
        pickDataChannel([{ service: DATA, uuid: "00002af0", properties: ["notify"] }]);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toHaveProperty("message", expect.stringContaining("adapters --inspect"));
  });
});

describe("canonicalUuid and matchesBleTarget", () => {
  it("expands short forms and dashes long ones", () => {
    expect(canonicalUuid("18F0")).toBe(DATA);
    expect(canonicalUuid("0000FFF0-0000-1000-8000-00805F9B34FB")).toBe(OTHER);
    expect(canonicalUuid("0000fff000001000800000805f9b34fb")).toBe(OTHER);
  });

  const device: BleAdvertisement = {
    id: "ID-1",
    address: "AA:BB:CC:DD:EE:FF",
    name: "vLinker FD",
    rssi: -40,
  };

  it("matches an address or identifier exactly and a name by substring, ignoring case", () => {
    expect(matchesBleTarget(device, "aa:bb:cc:dd:ee:ff")).toBe(true);
    expect(matchesBleTarget(device, "id-1")).toBe(true);
    expect(matchesBleTarget(device, "LINKER")).toBe(true);
    expect(matchesBleTarget(device, "AA:BB")).toBe(false);
    expect(matchesBleTarget({ ...device, name: undefined }, "linker")).toBe(false);
  });
});

const GATT: GattCharacteristic[] = [
  { service: GENERIC, uuid: "00002a00", properties: ["read"] },
  { service: DATA, uuid: "00002af0", properties: ["notify"] },
  { service: DATA, uuid: "00002af1", properties: ["write-without-response"] },
];

function rig(gatt: readonly GattCharacteristic[] = GATT): {
  central: FakeCentral;
  peripheral: FakePeripheral;
  other: FakePeripheral;
} {
  const peripheral = new FakePeripheral(gatt);
  const other = new FakePeripheral(gatt);
  const central = new FakeCentral([
    { device: { id: "x", address: "x", name: "Other", rssi: -80 }, peripheral: other },
    { device: { id: "ID-1", address: "AA:BB", name: "vLinker FD", rssi: -40 }, peripheral },
  ]);
  return { central, peripheral, other };
}

describe("BleTransport", () => {
  it("connects to the matching device, subscribes and carries data both ways", async () => {
    const { central, peripheral, other } = rig();
    const transport = new BleTransport(central, "vlinker", { scanTimeoutMs: 5000 });
    await transport.open();
    expect(central.scans).toEqual([5000]);
    expect(peripheral.connected).toBe(true);
    expect(other.connected).toBe(false);
    expect(peripheral.subscribed).toEqual(["00002af0"]);

    peripheral.emit(Uint8Array.of(1, 2));
    peripheral.emit(Uint8Array.of(3));
    expect(await transport.read(1000)).toEqual(Uint8Array.of(1, 2, 3));
    await expect(transport.read(20)).rejects.toThrow(TransportTimeout);

    await transport.close();
    expect(peripheral.connected).toBe(false);
    await transport.close();
    expect(peripheral.disconnects).toBe(1);
  });

  it("writes in 20-byte pieces on the picked characteristic, without response where offered", async () => {
    const { central, peripheral } = rig();
    const transport = new BleTransport(central, "vLinker");
    await transport.open();
    const data = Uint8Array.from({ length: 45 }, (_, index) => index);
    await transport.write(data);
    expect(peripheral.writes.map((w) => w.data.length)).toEqual([
      MIN_WRITE_SIZE,
      MIN_WRITE_SIZE,
      5,
    ]);
    expect(peripheral.writes.every((w) => w.characteristic === "00002af1" && !w.withResponse)).toBe(
      true,
    );
    expect(Uint8Array.from(peripheral.writes.flatMap((w) => [...w.data]))).toEqual(data);
    await transport.close();
  });

  it("passes the URL overrides through to the picker", async () => {
    const gatt: GattCharacteristic[] = [
      ...GATT,
      { service: OTHER, uuid: "0000fff1", properties: ["notify"] },
      { service: OTHER, uuid: "0000fff2", properties: ["write"] },
    ];
    const { central, peripheral } = rig(gatt);
    const transport = bleTransportFor(central, parseAdapterUrl("ble://vLinker?service=fff0"));
    await transport.open();
    await transport.write(Uint8Array.of(1));
    expect(peripheral.subscribed).toEqual(["0000fff1"]);
    expect(peripheral.writes[0]).toMatchObject({ characteristic: "0000fff2", withResponse: true });
    await transport.close();
  });

  it("fails when no device matches", async () => {
    const { central } = rig();
    await expect(
      new BleTransport(central, "nothing", { scanTimeoutMs: 3000 }).open(),
    ).rejects.toThrow(/no Bluetooth LE device matching "nothing" seen in 3 s/);
  });

  it("wraps a connection failure", async () => {
    const { central, peripheral } = rig();
    peripheral.connectError = new Error("refused");
    await expect(new BleTransport(central, "vLinker").open()).rejects.toThrow(
      /cannot connect to "vLinker": refused/,
    );
  });

  it("disconnects again when the device has no data channel", async () => {
    const { central, peripheral } = rig([
      { service: DATA, uuid: "00002af0", properties: ["notify"] },
    ]);
    await expect(new BleTransport(central, "vLinker").open()).rejects.toThrow(/adapters --inspect/);
    expect(peripheral.connected).toBe(false);
    expect(peripheral.disconnects).toBe(1);
  });

  it("fails reads and writes once the device drops, after delivering what it sent", async () => {
    const { central, peripheral } = rig();
    const transport = new BleTransport(central, "vLinker");
    await transport.open();
    peripheral.emit(Uint8Array.of(7));
    peripheral.drop();
    expect(await transport.read(1000)).toEqual(Uint8Array.of(7));
    await expect(transport.read(1000)).rejects.toThrow(/disconnected/);
  });

  it("refuses writes before open and a second open", async () => {
    const { central } = rig();
    const transport = new BleTransport(central, "vLinker");
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(/not open/);
    await transport.open();
    await expect(transport.open()).rejects.toThrow(/already open/);
    await transport.close();
  });
});
