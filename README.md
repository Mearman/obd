# obd-read

Read a car's diagnostics through an ELM327-style adapter, from a Node command line or from an installable, offline, responsive web app (a PWA), with software you can read and change.

`obd-read` talks to the control units behind the diagnostic socket: it reads their identification, stored fault codes and freeze frames. It can also clear a unit's fault codes, after saving what it is about to erase, and send a coding or adaptation write or an actuator test that you supply byte for byte, under the safeguards in [Writes and actuator tests](#writes-and-actuator-tests). It is read-only by default: every request passes one guard, and it has no security access, flashing or programming and no setting that adds them. The TopScan route (TOPDON's proprietary dongle) is not supported; [issue 3](https://github.com/Mearman/obd/issues/3) records what driving one would take.

## What it needs

- Node 24 or later and [pnpm](https://pnpm.io/), for the command line and for building the app. The PWA needs only a browser.
- An adapter that implements the full ELM327 command set, or a raw CAN adapter. Cheap clones that lack the addressing commands are detected and named on connection. On connection the tool also reports whether the adapter has the STN `ST` extensions, which it uses only where a plain ELM327 cannot do the job (see [Bit rates](#bit-rates) and [Requests longer than one frame](#requests-longer-than-one-frame)), in the bus monitor, and in `battery` to read the voltage with `STVR`.
- For anything beyond the legislated OBD-II reads, a vehicle profile (JSON). The profiles shipped are in [`src/profiles`](src/profiles).

## Install and build

```sh
pnpm install
pnpm build
node dist/node/bin.js adapters
```

`pnpm build` compiles the package to `dist/`; the `obd-read` binary is `dist/node/bin.js`. Dependencies are installed through pnpm only, with install scripts denied (the native packages ship prebuilt binaries; [`pnpm-workspace.yaml`](pnpm-workspace.yaml) lists them). The package is private and is not published to a registry.

The commands below are written as `obd-read`; run them as `node dist/node/bin.js` from a checkout, or link the binary.

## Adapter URLs

`adapters` lists the Bluetooth LE devices in range and the serial ports present. Name the adapter by URL on every other command, or pick it in the app.

| Scheme         | Example                                                                 | Runs in      |
| -------------- | ----------------------------------------------------------------------- | ------------ |
| `ble`          | `ble://<part of the device name, or its address>`                       | Node only    |
| `serial`       | `serial:///dev/tty.usbserial-1` (add `?baud=38400` to change the speed) | Node only    |
| `tcp`          | `tcp://192.168.80.1:35000`                                              | Node only    |
| `slcan`        | `slcan:///dev/ttyACM0` (add `?baud=921600` to change the speed)         | Node only    |
| `socketcan`    | `socketcan://can0` (Linux only)                                         | Node only    |
| `webserial`    | `webserial://<label>`                                                   | Browser only |
| `webbluetooth` | `webbluetooth://<device name prefix>` (`all=1` lists every device)      | Browser only |
| `webusb`       | `webusb://<label>` (a gs_usb adapter such as a candleLight or CANable)  | Browser only |

The `ble`, `serial`, `tcp`, `webserial` and `webbluetooth` links reach an ELM327-style adapter; `slcan`, `socketcan` and `webusb` reach a raw CAN adapter, described in [Raw CAN adapters](#raw-can-adapters). Raw TCP is not available in a browser, and a browser always asks the user to pick the device in a prompt opened by a gesture: the target of a `webserial` or `webusb` URL is only a label that selects nothing.

First run at a car, ignition on:

```sh
obd-read probe --adapter ble://vLinker --profile mercedes-w211 --log first-run.log
```

`probe` asks every unit in the profile to identify itself and prints which answered. Nothing else is sent.

## Entry points

| Entry point            | What it holds                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `obd-read`             | The platform-free core: the `Transport` contract, the ELM327 session, ISO-TP, KWP2000, UDS, OBD, the guard, profiles, scans and the service contract. It imports no `node:` module and no DOM-only global. |
| `obd-read/node`        | The Node transports (`ble`, `serial`, `tcp`, `slcan`, `socketcan`), adapter discovery and the `node:sqlite` storage. Importing it registers the transports.                                                |
| `obd-read/web`         | The browser transports (`webserial`, `webbluetooth`, `webusb`), `capabilities()` for explaining why one is unavailable, and the worker-backed storage. Importing it registers the transports.              |
| `obd-read/web/storage` | The storage worker protocol, importable without the browser transports.                                                                                                                                    |
| `obd-read/profiles`    | The bundled vehicle profiles and the generic fault-code titles.                                                                                                                                            |

Core never imports a platform module. Each platform entry point supplies the transports it can build and registers them with `registerTransport`; `openTransport(url)` then builds the transport an adapter URL names, and fails with a `TransportError` when no entry point serves the scheme.

## Commands

| Command                                                     | What it reads                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters`                                                  | Bluetooth LE devices and serial ports. `--inspect <name>` prints one device's services and characteristics.                                                                                                                                                                                                                                                                                                                               |
| `probe`                                                     | Which units in the profile answer.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ident <unit>`                                              | One unit's identification.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `faults <unit>`                                             | One unit's stored fault codes and status bytes.                                                                                                                                                                                                                                                                                                                                                                                           |
| `freeze <unit>`                                             | The freeze frame stored with each fault code.                                                                                                                                                                                                                                                                                                                                                                                             |
| `scan`                                                      | Identification and fault codes from every unit. `--output <path>` writes `<path>.json` and `<path>.md`; `--freeze` adds freeze frames.                                                                                                                                                                                                                                                                                                    |
| `obd`                                                       | Legislated OBD-II reads that need no profile: VIN, warning-lamp state, stored, pending and permanent codes, the freeze frame, misfire counts, which monitors have completed, every current-data value the car supports, the other mode 06 monitor results and the calibration identifier. `--kline <scheme>` reads over K-line instead of CAN. `--output <file>` also writes the read as JSON for `share`.                                |
| `clear-codes --save <file>`                                 | Erases the codes of every emissions unit, with no profile. See [Clearing fault codes](#clearing-fault-codes).                                                                                                                                                                                                                                                                                                                             |
| `live [<unit>]`                                             | Named live values, once or repeatedly. With no unit it reads the legislated values the car supports (`--list` shows their names); with a unit and `--profile` it reads the named values the profile defines for that unit. `--values a,b` picks some, `--count` and `--interval` repeat the read, `--csv <file>` logs each sample to a new file (an existing file is never overwritten).                                                  |
| `battery`                                                   | Logs the adapter's own voltage reading at a fixed interval (`--interval`, `--duration`), printing each sample and a summary, and writing a new CSV with `--csv <file>`. It reads `ATRV`, or `STVR` (with `--precision` decimals) on an adapter that has the STN extensions, and needs no profile and no car bus.                                                                                                                          |
| `mqtt`                                                      | Publishes what `live` reads, and the adapter voltage, to an MQTT broker every `--interval` seconds, with Home Assistant discovery. See [Home Assistant and MQTT](#home-assistant-and-mqtt).                                                                                                                                                                                                                                               |
| `request <unit> <hex>`                                      | One request of your choosing, for example `1A86`. Only read-only services are sent.                                                                                                                                                                                                                                                                                                                                                       |
| `discover --protocol <kwp2000\|uds>`                        | For a car with no profile: asks each 11-bit CAN request identifier in `--first` to `--last` (default `0x700` to `0x7FF`) to open the default session, and lists which answer and from which identifier. `--output <file>` writes the answers as an unconfirmed draft profile, named `--name`, for `profile check`. Every silent identifier waits out the adapter's reply timeout, so narrow the range when you can. Takes no `--profile`. |
| `simulate --profile <profile>`                              | Serves a scripted adapter and car over TCP on `127.0.0.1:35000` (`--host`, `--port`), so the tool and a profile can be tried with no car: `obd-read probe --adapter tcp://127.0.0.1:35000 --profile <profile>`. Every unit answers with one invented fault code and holds one invented writable record, and each connection starts a fresh car, so `clear`, `write`, `restore` and `actuate` can be tried safely.                         |
| `profile check <profile>...`                                | Validates profile files (or shipped names) without connecting to anything; exits 1 on any problem.                                                                                                                                                                                                                                                                                                                                        |
| `monitor`                                                   | Logs CAN traffic without transmitting.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `clear <unit> --save <file>`                                | Erases one unit's stored fault codes. See [Clearing fault codes](#clearing-fault-codes).                                                                                                                                                                                                                                                                                                                                                  |
| `compare <first> <second>`                                  | Two saved scans side by side. Needs no adapter.                                                                                                                                                                                                                                                                                                                                                                                           |
| `describe <scan or code>...`                                | Names for fault codes. Needs no adapter.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `import-names <file> --unit <name> --output <file>`         | Code and request names from a definition file you supply. Needs no adapter.                                                                                                                                                                                                                                                                                                                                                               |
| `share <file>`                                              | Makes a link that shares a saved scan or a run's JSON export, or with `--open <link>` prints what a link carries. Needs no adapter. TypeScript only. See [Sharing](#sharing).                                                                                                                                                                                                                                                             |
| `write <unit> --request <hex> --read <hex> --save <file>`   | Writes one coding or adaptation value you supply, after saving the value it replaces.                                                                                                                                                                                                                                                                                                                                                     |
| `restore <unit> --snapshot <file> --save <file>`            | Writes back the value a `write` saved.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `actuate <unit> --request <hex> --stop <hex> --seconds <n>` | Drives one actuator with a request you supply, then always sends your stop request.                                                                                                                                                                                                                                                                                                                                                       |

Every command that talks to a car takes `--adapter`, and `--log <file>` to keep the full exchange with the adapter. All except `obd`, `discover`, `clear-codes` and `battery` take `--profile`; for `live` and `mqtt` it is optional. Exit statuses: 0 on success, 1 for a command that failed or reported an `error:`, 2 for arguments the parser rejects, 130 after an interrupt. A snapshot, a CSV log, a monitor log and a draft profile are created exclusively and never replaced.

The `obd` command asks a car only for what it says it supports: the supported-identifier bitmaps decide which values are requested. The decoding follows SAE J1979. Mode 06 test meanings other than the misfire counters differ per maker, so those results are printed with their raw value, limits and scaling identifier and marked as unconfirmed.

Fault codes are printed as the unit reports them: hexadecimal code bytes and a status byte. `describe` adds names to them afterwards: the generic OBD-II titles in [`src/data/obdex-generic.json`](src/data/obdex-generic.json), which are the English titles from [OBDex](https://github.com/foerbsnavi/OBDex) (CC0 1.0), vendored rather than fetched so that the tool works offline in a garage and rebuilt by [`scripts/vendor-obdex.ts`](scripts/vendor-obdex.ts), plus names from a definition file you import with `import-names`.

## Clearing fault codes

Clearing erases the evidence a fault leaves behind, so `clear` does it in a fixed order and stops at the first step that fails:

1. Reads the unit's identification, fault codes and the freeze frame for each code.
2. Writes them, with the full adapter transcript, to the `--save` file. The file must not already exist.
3. Prints the codes and asks you to type `yes`. `--yes` skips the question.
4. Sends the clear request.
5. Reads the unit again and prints what remains.

A unit that refuses its freeze frames is recorded as such and can still be cleared. A unit whose fault codes cannot be read is not cleared. One unit is cleared per run.

`clear-codes` is the same procedure for a car with no profile, through the legislated clear (OBD-II mode 04). Mode 04 cannot target one unit: it erases the stored codes, freeze frame and misfire data of every emissions-related unit and resets their readiness monitors, which then need a drive cycle to complete. The command says so before it asks. It takes `--id-bits` and `--bitrate` like `obd`.

## Writes and actuator tests

No vendor requests ship with the tool. No readable source documents the Mercedes coding, adaptation or actuator requests for the cars this was built for, so the tool carries none and invents none: you supply the exact request bytes, from your own documentation, and the tool checks their structure, not their meaning. A wrong request can disable a control unit or move a part on the car. A unit may also refuse them in the session the profile opens ([issue 7](https://github.com/Mearman/obd/issues/7)).

`write` sends one write by identifier (KWP2000 `3B`, UDS `2E`). `--read` is the request that reads the same identifier (KWP2000 `21` or UDS `22`, then the identifier and nothing else). The order is fixed and stops at the first step that fails: it opens the profile's session and reads the current value (if that read fails, nothing is written); it saves the unit, address pair, protocol, both requests, the current value, a timestamp and the full adapter transcript to the `--save` file, which must not already exist; it prints the request and both values and asks you to type `yes`, with no flag that skips the question; it sends the write once; and it reads the value again and says whether it now matches, exiting 1 and naming the snapshot to restore from when it does not.

`restore` writes back the value a `write` snapshot saved, to the same identifier, under the same steps. It refuses a file that is not a write snapshot, or one taken from another unit, address pair or protocol.

`actuate` sends one input or output control request (KWP2000 `30`, UDS `2F`) and afterwards the stop request you give with `--stop`, which must be the same service and name the same identifier. `--seconds` is capped, because an output held longer than its normal duty can overheat or sit at its end stop. It asks you to type `yes` (no flag skips it), sends the start request, holds for `--seconds` sending tester present so the unit stays in its session, and then sends the stop request whatever happened before it: a refused or silent start, an error mid-test, a timeout or an interrupt. If the stop request itself fails, the error says so, and switching the ignition off ends the test.

## The guard

Every request passes one guard (`permit()` in [`src/core/guard.ts`](src/core/guard.ts)) before it reaches the adapter.

| Protocol | Read-only services allowed                                                          | Services allowed only with a token         |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| KWP2000  | `10` (default and standard diagnostic sessions), `12`, `17`, `18`, `1A`, `21`, `3E` | `14` clear, `3B` write, `30` actuator test |
| UDS      | `10` (default and extended sessions), `19`, `22`, `3E`                              | `14` clear, `2E` write, `2F` actuator test |
| OBD-II   | modes `01`, `02`, `03`, `06`, `07`, `09`, `0A`                                      | mode `04` clear                            |

A token is issued only by the guard, only to the command that ran the safeguards for it, in the same run:

- `clear` and `clear-codes` get a clear token once the snapshot is on disk.
- `write` and `restore` get a write token for one exact request, once a snapshot recording that request and the value it replaces is on disk.
- `actuate` gets a pair of tokens for its exact start and stop requests, after the confirmation.

Write and actuation tokens pass one request each, once, and cannot pass any other request or service; the `request` command and every read command carry no token, so they cannot send `14`, `2E`, `2F`, `30`, `3B` or mode `04`. Everything else is refused before sending, with or without a token: security access (`27`), resets (`11`), routine control (`31`), communication control (`28`), DTC setting control (`85`), programming and other sessions, data transfer (`34` to `37`) and every service not in the table. There is no setting that turns the guard off, in Node or in the app.

The request layouts the guard checks come from the ISO/DIS 14230-3 draft of 16 December 1996 for KWP2000 (tables 6.4.2.1, 7.1.2.1, 7.5.2.1 and 9.1.2.1, [as mirrored in the sv650sds wiki](https://raw.githubusercontent.com/wiki/synfinatic/sv650sds/pdfs/14230-3.pdf)) and [python-udsoncan's service implementations](https://github.com/pylessard/python-udsoncan/tree/master/udsoncan/services) for UDS.

## Vehicle profiles

A profile is a JSON file with the bus settings, the diagnostic protocol and one entry per control unit, validated by the Zod schema in [`src/core/profile.ts`](src/core/profile.ts):

```json
{
  "name": "example-car",
  "description": "Example chassis",
  "status": "unconfirmed",
  "bus": { "id_bits": 11, "bitrate": 500000 },
  "diagnostics": { "protocol": "kwp2000", "session": 146 },
  "units": {
    "engine": {
      "description": "Engine control unit",
      "request": 2016,
      "response": 2024,
      "source": "where this address pair comes from"
    }
  }
}
```

Identifiers and the session are plain JSON numbers (146 is `0x92`, 2016 is `0x7E0`). Read the bundled profiles in [`src/profiles`](src/profiles) for the exact field spellings, including K-line profiles, which name an initialisation scheme instead of CAN settings. Pass a shipped profile by name (`--profile mercedes-w211`) or your own by a path ending in `.json`. Every unit needs a `source`, so an address can be traced to where it was found. Run `obd-read profile check ./my-car.json` before first use: beyond what loading rejects it reports unknown keys, identifiers too wide for the bus, a request and response that are the same, an identifier shared by two units and blank sources. The app imports a profile from a local JSON file the same way. Which live values the shipped profiles define is [issue 6](https://github.com/Mearman/obd/issues/6).

A unit may carry its own `diagnostics` (the same `protocol` and `session`) when the car mixes services: the profile's applies to every unit that has none, so a KWP2000 profile can hold one UDS unit. The session must be a read-only one for the unit's own protocol, and a named value's identifier must fit it.

A unit reached with ISO 15765-2 extended addressing also has an `extended_address`: the target byte that goes first in every frame sent to it, so several units can share one request identifier. The adapter then sets it with `ATCEA`, puts it first in the flow-control data and expects each reply frame to start with the tester address 0xF1. The check treats a request as the identifier with its target byte, and refuses one identifier used both with and without one.

The shipped profiles are `mercedes-w211`, `vag-mqb`, `mazda-skyactiv` (Mazda SkyActiv cars on 11-bit CAN), `honda-acura-29bit` (Honda and Acura 29-bit `18DAxxF1` units, from open projects that describe mostly North American and Japanese cars, so a UK car may differ; both in [docs/vehicles/japan-korea.md](docs/vehicles/japan-korea.md)), two PSA profiles (`psa-uds` and `psa-kwp2000`, for Peugeot, Citroen, DS and Opel or Vauxhall cars on PSA platforms, split because the protocol belongs to the unit and not its identifier), `vw-up` (the e-Up, Citigo-e iV and Mii electric, from two community sources in [docs/vehicles/vag-group.md](docs/vehicles/vag-group.md)), five Renault Alliance profiles (below) and three BMW profiles that use extended addressing over the OBD socket's CAN (D-CAN): `bmw-f-fem` (F-series cars with a front electronics module), `bmw-i3` (i3 and i3s) and `bmw-g29` (Z4 G29 and Supra J29, engine only). Every one is unconfirmed until read from a car; [docs/vehicles/bmw-mini.md](docs/vehicles/bmw-mini.md) gives the sources. Three more cover Japanese makes, each unconfirmed until read from a car, with their sources and contradictions in [docs/vehicles/japan-korea.md](docs/vehicles/japan-korea.md): `nissan-leaf` (Leaf ZE0 and AZE0), `nissan-infiniti-can` (Qashqai J11, Juke F15 and X-Trail T32, with its 29-bit units marked by a per-unit `id_bits`) and `mitsubishi-phev-imiev` (Outlander PHEV, i-MiEV, C-Zero and iOn). Their units answer at response offsets other than 8, and each unit may carry its own `diagnostics` (protocol and session) because one car mixes KWP2000 service 21 and UDS service 22. A newer Nissan with a secure gateway may stay silent, which is reported as no response. No source shows a Leaf, Qashqai, Juke, X-Trail or Mitsubishi unit accepting the session these profiles open: opendbc sends `10 81` then `21 83` only for software-version fingerprinting, OBDb's Leaf file sets `diagnosticLevel` `C0` (which the guard does not allow), and the Mitsubishi sources open no session, so 0x81 there is only a guard-permitted placeholder; confirming it on a real car is [issue 70](https://github.com/Mearman/obd/issues/70). BMW and Mini families without a profile, and the confirmation each BMW profile needs, are deferred issues:

- E-series on D-CAN, which the core can reach but no source names the units for: [issue 17](https://github.com/Mearman/obd/issues/17)
- K-line cars (DS2, KWP2000 on K-line), which need a K+DCAN cable and a DS2 transport: [issue 18](https://github.com/Mearman/obd/issues/18)
- F and G series over ENET (HSFZ), which an ELM327 or STN adapter cannot reach: [issue 19](https://github.com/Mearman/obd/issues/19)
- F-series without a front electronics module: [issue 21](https://github.com/Mearman/obd/issues/21)
- Mini: [issue 24](https://github.com/Mearman/obd/issues/24)
- Confirming `bmw-f-fem`, `bmw-i3` and `bmw-g29` on a car: [issue 20](https://github.com/Mearman/obd/issues/20), [issue 22](https://github.com/Mearman/obd/issues/22) and [issue 23](https://github.com/Mearman/obd/issues/23)

The PSA profiles hold one row per request and response pair from a community ECU table, with the families that share each pair named in its description; the unit behind a row is read from its identification, not inferred from the ID. Which protocol a unit speaks depends on its model, so a unit silent under one profile may answer under the other. AEE2004 and AEE2010 cars carry diagnostics on OBD pins 3 and 8, not the usual 6 and 14, so an ELM327 or STN adapter needs a pass-through adapter or cable, and one source advises a branded adapter rather than a clone. The diagnostic CAN is set to 500 kbit/s, which the better source gives; another reports 250 kbit/s for the bus on pins 6 and 14 (unconfirmed, [issue 38](https://github.com/Mearman/obd/issues/38)). NEA2020 cars are reported to use pins 6 and 14 for DoIP (Ethernet), which this tool cannot reach, and one source says classic CAN diagnostics are there too. Every row is unconfirmed; [docs/vehicles/europe-other.md](docs/vehicles/europe-other.md) gives the sources, contradictions and exclusions.

A unit may also carry `id_bits` (11 or 29), the width of its own CAN identifiers, for a car that mixes the two on one socket: the bus `id_bits` is the default and a unit with its own width makes the session switch the adapter between the 11-bit and 29-bit protocols at the bit rate already selected, so a unit with 29-bit identifiers needs no second profile. The check reads each identifier against its own unit's width.

The five Renault Alliance profiles are `renault-zoe-ph1`, `renault-zoe-ph2` (11-bit and 29-bit units), `renault-twizy`, `renault-twingo-smart-453` (Twingo III and smart 453, with the security gateway on 29-bit identifiers) and `renault-dacia-core` (ten core units for Clio IV and V, Captur, Megane IV, Duster and Sandero, scoped to cars up to about the 2018 model year, which is an inference). Their address tables come from the CanZE ECU files and the ddt4all address table, and every row is unconfirmed until read from a car. Renault fits a security gateway to recent cars: a silent unit is reported as no response, not as absent, and nothing is known about what the gateway filters. [docs/vehicles/europe-other.md](docs/vehicles/europe-other.md) lists the sources opened, what is confirmed and what is only reported.

## Home Assistant and MQTT

`mqtt` reads the same values as `live` and publishes each one to an MQTT broker every `--interval` seconds, together with the adapter's own voltage reading unless `--no-voltage` is given. It sends no request that `live` does not, and every request still passes the guard.

```sh
OBD_READ_MQTT_USER=car OBD_READ_MQTT_PASSWORD=... \
  obd-read mqtt --adapter ble://vLinker --broker-host homeassistant.local --interval 10
```

| Option                           | Meaning                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--broker-host`, `--broker-port` | The broker, port 1883 unless given. `--tls` connects over TLS with the system certificate authorities.                                   |
| `--topic-prefix`                 | Prefix of the state topics, `obd-read` by default. Each value goes to `<prefix>/<device>/<value>`, not retained.                         |
| `--discovery-prefix`             | Home Assistant's MQTT discovery prefix, `homeassistant` by default.                                                                      |
| `--device-id`                    | The Home Assistant device and topic identifier. By default it is derived from `--adapter`, so one adapter is one device across restarts. |
| `--count`                        | Samples to publish; the default 0 keeps going until interrupted.                                                                         |

The broker user name and password are read only from the environment variables `OBD_READ_MQTT_USER` and `OBD_READ_MQTT_PASSWORD`. No option accepts them, so they never reach a shell history or process list, and the command never prints, logs or publishes them. A password without a user name is refused.

Before the first sample the command publishes one retained discovery message per value, carrying the unit of measurement, a device class where Home Assistant lists the unit for one, a `measurement` state class for values with a unit, an `expire_after` of three intervals and the shared device. It then publishes `online` to the retained `<prefix>/<device>/availability` topic. The broker is given `offline` for that topic as its last will, so a connection lost without a clean disconnect leaves every sensor unavailable. A value that could not be read in a sample is not published, and its sensor expires.

## Bit rates

250 and 500 kbit/s use the ELM327 protocols 6 to 9. Any other rate, such as 125 kbit/s for the mid-speed bus on pins 3 and 11 of some Ford and Volvo cars, is set in one of two ways, and the adapter's own reply decides whether it worked:

- **STN adapters:** the 500 kbit/s protocol is selected, then `STPBR <rate>` sets the rate and `STPBRR` reads back the rate in use. The manual says `STPBR` rounds to the nearest rate the hardware can generate and clamps without an error, so any difference from the requested rate is refused.
- **Plain ELM327:** user-defined protocol B, through `ATPC`, `ATPB <options> <divisor>` and `ATSPB`. The divisor is 500 kbit/s divided by the rate, so only rates that divide 500 kbit/s into a whole number from 1 to 64 are reachable (125 kbit/s is divisor 4). Anything else is refused before a byte is sent.

An adapter that rejects the command stops the run with the command named. Sources: the ELM327 datasheet (`AT PB`, `AT PC`, `AT SP`, PP 2B to 2D) and the OBDLink Family Reference and Programming Manual revision F (`STPBR`, `STPBRR`). The adapter's transceiver also has to be wired to the pins the bus uses: most adapters reach pins 6 and 14 only.

## Requests longer than one frame

A request of up to 7 bytes goes as one CAN frame on any adapter. A longer one, such as a read of several data identifiers at once, goes only through an adapter with the STN extensions: `STPX h:<id>, d:<data>` transmits it, segmented per ISO 15765-2, and turns transmit segmentation on only for that message. Addressing a unit on such an adapter also registers the unit's identifier pair with `STCFCPA`, because the adapter waits for the unit's flow-control frame and recognises it only for registered pairs. A raw CAN link segments it itself and needs no extensions. A plain ELM327 refuses a long request with a message naming the reason, since its datasheet documents no multi-frame sending; nothing is sent. The longest request is 4095 bytes, the ISO 15765-2 limit. Sources: the OBDLink Family Reference and Programming Manual revision F (`STPX`, `STCSEGT`, `STCFCPA`).

## Raw CAN adapters

A raw CAN link is presented to the session as an ELM327 adapter (`RawCanTransport`), so the same session code drives it, with the ISO 15765-2 work the ELM327 does in firmware done in core.

- `slcan://<serial device>?baud=N` is an SLCAN adapter on a serial port.
- `socketcan://<interface>` is a Linux SocketCAN interface (`can0`, `vcan0`, or a candleLight adapter running gs_usb firmware) reached through the optional `socketcan` package. It is a native addon that is Linux-only and is not built during `pnpm install` because install scripts are denied: on Linux run `pnpm rebuild socketcan` once (it needs a C++ toolchain), and set the interface's bit rate outside the program (`ip link set can0 type can bitrate 500000`).
- `webusb://<label>` drives a candleLight, CANable or other gs_usb adapter directly from a browser over WebUSB, which is also the route on macOS and Windows, where there is no SocketCAN. The picker is limited to the gs_usb vendor and product ids unless `usbVendorId` and `usbProductId` are given, and `channel` selects a channel on a multi-channel adapter. The gs_usb protocol and bit-timing calculation are in [`src/core/gsusb.ts`](src/core/gsusb.ts).

## The app

[`app/`](app) is the browser app, a separate private workspace package (`obd-read-app`) that depends on the package through the workspace. It is an installable PWA built with Vite and React. Styling is vanilla-extract (a CSS-variable theme contract for light and dark, recipes and sprinkles) over Radix UI primitives, so there is no runtime style engine. The layout is mobile-first with phone, tablet and desktop breakpoints, 44 px touch targets and safe-area insets, and data tables reflow to cards on narrow screens.

The screens (Connect, Scan, Live values, Runs, Settings) use the oRPC client for the `DiagnosticsService` contract over a message port to a dedicated worker ([`app/src/service/`](app/src/service)). Connect opens a connection with a vehicle profile, or with none ("Generic OBD-II (no profile)", the default; see [Generic OBD-II sessions](#generic-obd-ii-sessions)); Scan reads every unit and offers the guarded operations (clear, write, actuator test), each as a dialog that shows what would be sent and the saved snapshot and sends nothing until "Send to the car"; Live values starts and stops a collection run; Runs lists stored runs, exports CSV or JSON and resumes an open run; Settings imports a profile into the service's storage. The simulator is a selectable adapter (`simulator://<profile>`, or `simulator://generic-obd2` for a car with no profile), and every screen labels what it shows as "Simulated data".

Build the package first, because the app imports it through its built exports, then work in the app:

```sh
pnpm install
pnpm build
pnpm --filter obd-read-app dev
```

### Storage and the service boundary

Storage is a `Storage` interface in core. Its implementations are an in-memory one, SQLite through Drizzle over `node:sqlite` in Node (`openNodeStorage`), and sqlite-wasm on the Origin Private File System in the browser, where a dedicated module worker owns the database and the page posts SQL to it (`openWorkerStorage`). Drizzle stays behind `Storage`: the SQL migrations `drizzle-kit` generates from [`src/storage/schema.ts`](src/storage/schema.ts) are embedded in `src/storage/migrations.ts` so a browser build needs no file access. After changing the schema run `pnpm storage:generate`; a test fails when the embedded module and the migration folder disagree.

The worker (`app/src/database/`) holds an exclusive Web Lock, installs sqlite-wasm's `opfs-sahpool` VFS (which needs no cross-origin-isolation headers), applies the migrations and asks for persistent storage. That VFS allows one connection, so a second tab or window is told the app is already open elsewhere. Settings exports the database as a `.sqlite` file and imports one, checked in a scratch database before it replaces anything.

The service boundary is an oRPC contract, `DiagnosticsService` in [`src/core/service.ts`](src/core/service.ts), served and consumed over a message port (`serveDiagnostics`, `connectDiagnostics`). Contract suites run the same tests against every `Storage` implementation and against the service in process and over a message port.

### Generic OBD-II sessions

`link.connect` and `runs.start` take an optional `profile`. With none the connection is generic: it speaks only the legislated OBD-II services (SAE J1979), on the 11-bit 500 kbit/s CAN settings the `obd` command defaults to, and selects the bus explicitly, as `obd` does, instead of using the adapter's automatic protocol detection. `scan.run` returns the structured OBD report in `obd` (VIN, per-unit lamp, stored, pending and permanent codes, readiness, freeze frame, the supported live values, mode 06 results and calibration identifiers) and the same data as one unit report per answering emissions unit in `units`. A run with no profile collects the legislated values the car supports and is stored under the reserved profile name `generic-obd2`, which a profile import may not use; its scan reports and clear snapshots carry the same name. `clear.request` with `{ kind: "obd" }` is the only change a generic session can make, through the same snapshot, confirmation and clear token as before. Everything that addresses one control unit (`link.probe`, `units.*`, a unit `clear`, `write`, `actuate`, a run naming a `unit`) rejects with the error code `PROFILE_REQUIRED` before anything is sent, saved or parked, and the app disables those controls with the reason. Every request still passes the guard, whose OBD-II table allows modes `01`, `02`, `03`, `06`, `07`, `09` and `0A`, and mode `04` only with a clear token. The app does not suggest a profile after reading the VIN, because a profile carries no manufacturer identifier or model hint to match it against.

### The service host

`createDiagnosticsService` (core) wires what an edge needs: a `DeviceLink` (the one adapter connection, with a lock so a scan, a poll and a guarded operation never interleave), a `LiveCollector` and the `DiagnosticsHost` whose router is served over a message port or a socket. The edge supplies `Storage`, a `TransportHost` and a profile loader.

- Reads: `link.connect`, `link.probe`, `units.ident`, `units.faults`, `units.freeze`, `scan.run` (saved as a scan report), `battery.voltage`, `monitor.capture` (listen-only; needs the adapter free) and `reports.list` and `reports.get`.
- Changes to the car are two calls each. `clear.request`, `write.request` and `actuate.request` run the existing command until it would ask for a typed `yes`, and return what it printed (what would be sent), the saved snapshot and a confirmation id. `clear.confirm`, `write.confirm` and `actuate.confirm` answer yes, and `guarded.cancel` answers no. The guard's single-use tokens exist only inside the commands the host runs. The confirmation id is a handle to a parked command, not a token: it passes once, belongs to one kind of operation, expires, and only one can be pending, because the parked command holds the adapter. No client mints or holds anything that authorises a request.
- Collection: `runs.start`, `runs.stop`, `runs.resume`, `runs.status`, `live.samples` (an async iterator) and the stored-run reads and exports. A run polls either a unit's named profile values (`unit`) or the legislated values the car supports, and stores readings in batches. When the link drops (a transport or adapter error) the collector reconnects with exponential backoff and carries on; any other error ends collection as `failed` and leaves the run open. After a reload the run record and its samples remain in storage and `runs.resume` collects into the same run again. A run's selection of unit and values is kept as a final line of its notes until `Storage` has a field for it. One run holds the adapter at a time, and while it does the other adapter operations refuse.
- `simulator://<profile>` is an adapter URL served by the simulator host: a fresh simulated car whose engine unit answers a few live values that change on every read. Every reading is invented.

#### Where each transport runs

The service runs in a dedicated worker in the app. Which transport can live there is a browser fact, recorded with where it was read:

- Web Serial: Chromium's interface definition [`serial.idl`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/serial/serial.idl) (main branch, read 2026-11-15; [Wayback snapshot](https://web.archive.org/web/20261115113855/https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/serial/serial.idl)) exposes the `Serial` interface to `Window` and `DedicatedWorker`, and `requestPort` to `Window` only.
- WebUSB: [`usb.idl`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webusb/usb.idl) (read 2026-11-15; [Wayback snapshot](https://web.archive.org/web/20261115113919/https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webusb/usb.idl)) exposes the interface to `DedicatedWorker` under a runtime-enabled feature named `WebUSBOnDedicatedWorkers`, and `requestDevice` to `Window` only. Chrome Platform Status lists "WebUSB on Dedicated Workers" as enabled by default since Chrome 70 on desktop and Android, with no flag and no origin trial ([API entry](https://chromestatus.com/api/v0/features/5928209916887040), read 2026-11-15; [Wayback snapshot](https://web.archive.org/web/20261115113937/https://chromestatus.com/api/v0/features/5928209916887040)).
- Web Bluetooth: [`bluetooth.idl`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/bluetooth/bluetooth.idl) (read 2026-11-15; no Wayback snapshot, the save did not complete) is `[Exposed=Window, RuntimeEnabled=WebBluetooth, SecureContext]`, so it is not available in workers. MDN's [Web Bluetooth API page](https://developer.mozilla.org/docs/Web/API/Web_Bluetooth_API) says the same.

Chrome's own capability guides for serial, WebUSB and Web Bluetooth do not mention workers, which is why the sources above are the interface definitions. No run in a real worker with a device has been made.

So `webserial` and `webusb` transports run in the worker (`WORKER_SCHEMES`) and `webbluetooth` stays on the page (`PAGE_SCHEMES`), reached from the worker through `remoteTransportHost` over a second message port. Device pickers need a user gesture and so always run on the page. For Bluetooth the page opens the transport inside the click (`TransportBridge.prepare`) and the worker's connect adopts it. For serial and USB the page runs the picker, describes the grant (`requestSerialGrant`, `requestUsbGrant`) and sends it with `adapters.grant`, and the worker's transport picks the matching device from `navigator.serial.getPorts()` or `navigator.usb.getDevices()`.

The worker's storage is the page's database: the page serves its `Storage` to the worker over a third port (`serveStorage`, `remoteStorage`), so there is one connection and one writer. While the database is opening the worker's requests wait; when it cannot be used (another tab holds it, no OPFS) they go to memory and the app says nothing will be saved.

### Hosting, installing and offline behaviour

A PWA needs a secure context: serve the built app (`app/dist/`, with relative URLs so it can sit under any path) over HTTPS. `localhost` also counts as secure, which is how the end-to-end tests and `pnpm --filter obd-read-app preview` run it. Web Serial, Web Bluetooth and WebUSB are available only in a secure context.

`vite-plugin-pwa` precaches the whole shell, the bundled profiles, the database worker and the SQLite `.wasm` file, and generates the manifest and icons from [`app/public/icon.svg`](app/public/icon.svg) at build time. After the first load the app starts and opens its stored data with no network. The app makes no runtime network requests (an ESLint rule forbids `fetch`, `XMLHttpRequest` and `WebSocket` in `app/src/`), loads no CDN scripts and no web fonts. A new service worker waits until the user chooses Reload in the update toast, so an update never interrupts a scan.

### Background collection

Collection continues while the app is open, in the foreground or in a background tab the browser has not frozen. No web API guarantees collection in the background: with the screen off or the app closed, Android may suspend or stop it, and a Web Bluetooth connection is held by the page, not by the service worker or the operating system. The collector runs in a dedicated worker so a busy page does not delay a poll, the app asks for a screen wake lock while a run collects, reconnects when the link drops and resumes a run after a reload, but none of that overrides the browser. A guaranteed unattended recorder is the Node command line (`live --csv`, `battery --csv`, `mqtt`) on a machine that stays on, such as a Raspberry Pi. Android Auto is not a target for the PWA.

### Browser support

Chrome and Edge, on Android and desktop. Safari, Firefox and every iOS browser (all WebKit) have no Web Serial, Web Bluetooth or WebUSB, so the app cannot reach an adapter there; the Connect screen says why. The shell itself loads in any modern browser.

## Sharing

A scan, a generic OBD-II read or a run summary can be shared as a link. The result is packed into the fragment of the app's address, `https://mearman.github.io/obd/#share=1.<payload>`, so it is never in the part of the address a browser sends to a server: opening the link makes the same request as opening the app, and the data is read in the page.

The Scan screen and each row of the Runs screen have a Share button. Its dialog lists what the link carries, offers to remove the VIN and serial numbers or calibration identifiers (on by default), shows the link's length against the practical limit and copies the link or hands it to the system share sheet where the browser has one. A scan link carries the profile name, the time of the scan, the adapter's own name for itself, and for each control unit whether it answered, its identification values, its fault codes with their status bytes and its freeze frames. It does not carry the raw adapter transcript or the adapter's address. A generic OBD-II read (the Scan result of a connection with no profile) is shared as a report link: it carries the stored, pending and permanent codes of each emissions unit, its warning lamp and readiness monitors, the VIN, the freeze frame, the supported current-data values with their units, the mode 06 results and misfire counts, the time of the read and the adapter's own name for itself. It carries the codes but not their names, which a reader looks up from the codes (`share --open` names them from the bundled generic titles). A run link carries the run's details and, for each signal, the count, minimum, maximum and mean and at most 120 readings over time, not every sample.

A page opened with `#share=` shows the result read-only, labelled as shared data with the time the link was made and clearly not from the connected adapter. It is checked against a strict schema first, and it never reaches the diagnostics service, the guard or an adapter. Nothing is written to storage unless Save is pressed, which keeps a scan as a saved scan report marked `origin: "shared"`; Save and Dismiss both remove the fragment from the address bar. A run summary and an OBD-II report have no Save, since neither is a run or a per-unit scan; the report is shown with the same components as the Scan screen's own result.

Removing the VIN blanks every identification value labelled as a VIN or serial number and replaces any VIN-shaped word found in other identification values (as text or as the ASCII of their bytes), notes and freeze frames. For an OBD-II report the VIN and every calibration identifier are blanked (a VIN that was not reported stays not reported) and any copy of either, or VIN-shaped word, in a note, a freeze frame or a text reading is replaced. It cannot find a VIN that a unit hides in bytes that are not its ASCII.

A link is limited to 32,000 characters and its data to 256 KiB before compression; a link over the limit is refused with the size and the limit rather than cut. Links over about 2,000 characters are cut by some chat apps and mail clients. A generic read of the recorded 2009 petrol hatchback (`test/fixtures/a150-*.txt`, one emissions unit, eighteen current-data values and no mode 06 results) makes a link of about 1,200 characters under the published address with the identifiers removed, well inside that limit. When a result is too large, use the file instead: the saved scan JSON (`scan --output`) or the run's CSV or JSON export.

```sh
obd-read share scan.json --redact-vin
obd-read obd --adapter <url> --output read.json
obd-read share read.json --redact-vin
obd-read share run.json --base https://example.com/obd/
obd-read share --open 'https://mearman.github.io/obd/#share=1....'
```

`obd --output <file>` reads once, prints the read (with generic code titles) and writes it as JSON; it works over CAN and K-line like `obd`. `share` takes a scan report (`scan --output`), that OBD-II read file or a run's JSON export and prints the link, under `--base` (the published app by default). `--open` prints what a link carries in the format `describe` uses, with the profile's fault-code names only for a profile this program ships. `share` has no Python equivalent, so it has no recorded golden output; it is covered by its own tests.

A link carries fault history, and anyone who has it can read it: it is only as private as the place it is pasted. There is no QR code, since a link long enough to carry a scan is more than a phone camera reads reliably from a screen.

## Reporting problems

If a screen fails, the app shows what happened in plain language in place of that screen, with Try again, Go to Connect and Report this problem. The rest of the app, the connection and any run in progress keep working, because the screen is contained by an error boundary and the diagnostic service runs in its own worker. Errors a boundary cannot see (uncaught errors and unhandled promise rejections on the page, errors of the app's workers, and service calls that fail in a way the screens do not expect) show a notice with the same Report this problem button. A refused guard request, a missing profile or an adapter that does not answer is an ordinary state each screen explains itself, never a reported error.

Report this problem opens a dialog with the exact text that will go into a GitHub issue: a title, the error's name, message and stack, the app version and build, the browser family and major version, the operating system family, which hardware APIs the browser has, and a short log of recent app events. Issues in this repository are public, so the dialog says so. The report can be copied or downloaded, and Continue to GitHub opens the repository's new-issue form in a new tab with the title, body and the `bug` label filled in. The link is kept to a length GitHub accepts by leaving out the oldest events first and saying so in the body; if even the shortest report would not fit, the link carries a one-line note and the whole report is copied to the clipboard to paste. The app sends nothing itself: there is no analytics, beacon or request of any kind, and you submit the issue on GitHub yourself. [`.github/ISSUE_TEMPLATE/app-error.md`](.github/ISSUE_TEMPLATE/app-error.md) has the same sections for writing one by hand.

The event log is kept in memory only, is bounded in count and size, and is lost when the page closes. It records kinds and outcomes: which screen was shown, that a connection was made or ended and by which transport type (Web Serial, Web Bluetooth, WebUSB or the simulator), which service operation ran and how it ended (ok, refused by the guard, profile required, adapter error, timeout and so on), the state of storage and of the service worker, and where an error was caught. It never records data values, hexadecimal payloads, VINs, serial numbers, fault codes, adapter names or addresses, device identifiers, file names or paths, profile contents, share-link fragments or anything typed into the app; the event type has no field that could hold them.

Error text is anonymised before it is shown ([`app/src/report/anonymise.ts`](app/src/report/anonymise.ts)): VIN-shaped words (the same rule as [removing the VIN from a share link](#sharing)), long hexadecimal runs and spaced bytes, fault codes, MAC, IP and email addresses, UUIDs and long identifier-like tokens, file paths and names, URLs (only the app's own origin and path survive, never a query or fragment), quoted text, and the adapter's name and address for the current connection are replaced by a placeholder. Stack frames are cut to a function name and the app's own file and line; frames from other origins, such as an extension or a third-party script, are dropped and counted. Shape-based scrubbing cannot find a value with no recognisable shape that was not quoted, so read the report in the dialog before continuing.

## What stays unverified until the dongle and car are together

Everything above the link is tested against scripted adapters and cars, fake transports and a headless Chromium. The following has not been run against real hardware, and each item has an open issue:

- Adapter behaviours that were written from documentation: `STPBR` taking effect before the protocol opens, which bit rates each STN model accepts, whether a clone honours the `ATPB` divisor, the longest `STPX` line, eight-digit `h:` identifiers for 29-bit CAN, `STCFCPA` registration for non-legislated identifiers, the `STVR` reply format, K-line checksum and idle output, and ELM327 acknowledgement while monitoring ([issue 5](https://github.com/Mearman/obd/issues/5)). The vLinker FD+ is the intended adapter, and its real service and characteristic UUIDs are unconfirmed: Bluetooth LE adapters do not share one layout, so the tool picks the first service with both a notifying and a writable characteristic, and `?service=`, `?notify=` and `?write=` on the URL override that choice.
- The real Web Serial, Web Bluetooth and WebUSB paths, a device granted on the page and used in the worker, and the installed PWA on a phone: install prompt, standalone display, offline launch, the update toast and the unsupported-browser messages on real devices ([issue 9](https://github.com/Mearman/obd/issues/9)).
- The database worker with `opfs-sahpool` on Android Chrome, whether the installed app is granted persistent storage, and that stored runs survive the app being closed and reopened ([issue 10](https://github.com/Mearman/obd/issues/10)).
- The `socketcan://` addon, which has been neither built nor run against a real or virtual CAN interface ([issue 8](https://github.com/Mearman/obd/issues/8)), and gs_usb over WebUSB, checked against a fake adapter only.
- Writes, restore and actuator tests on a real car: whether a unit accepts them in the session the profile opens ([issue 7](https://github.com/Mearman/obd/issues/7)), and live value identifiers for the shipped profiles ([issue 6](https://github.com/Mearman/obd/issues/6)).
- A generic OBD-II session on a real car: it has run only against the simulator and scripted adapters, and it reads on 11-bit 500 kbit/s CAN only, so a car on another bus needs the `obd` command's `--id-bits`, `--bitrate` or `--kline` options.
- The `mqtt` command against a real broker and Home Assistant: it is tested against a recording stand-in for the broker connection.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter obd-read-app lint
pnpm --filter obd-read-app typecheck
pnpm --filter obd-read-app test
pnpm --filter obd-read-app build
pnpm --filter obd-read-app e2e
```

CI runs the same commands. `pnpm test:parity` runs the command line against the recorded contract in [`test/golden`](test/golden): [its README](test/golden/README.md) says where the records came from, and the only differences allowed are listed in `test/parity/normalise.ts`. Two checks keep core platform-free: an ESLint `no-restricted-imports` and `no-restricted-globals` rule on `src/core/`, and `tsconfig.core.json`, which typechecks it with neither the Node nor the DOM type libraries.

`pnpm --filter obd-read-app e2e` builds the app, serves it with `vite preview` on localhost, and in Chromium takes screenshots of every screen at phone, tablet and desktop widths in both colour schemes into `app/screenshots/` (untracked). It asserts that nothing overflows horizontally and that every interactive element is at least 44 px, reloads offline to check the shell loads from the service worker, builds and serves the app under both `/` and `/obd/` (a static server that 404s outside the prefix, as Pages does) to check the manifest, the service worker scope, a deep link and an offline reload, and drives the real database worker and OPFS (write a run, reload, reload offline, a second tab, export and import), and makes a share link from a simulator scan, and from a generic simulator scan, opens it in a fresh browser context to check the read-only viewer and that nothing is stored until Save, and reloads it offline and forces an error (a hook that exists only in the end-to-end build, which a test checks the production build lacks) to check the problem report dialog, that its text carries none of the simulator session's VIN, adapter name, address or payload bytes, and the new-issue link it makes. Install the browser once with `pnpm --filter obd-read-app exec playwright install chromium`, or point `OBD_READ_CHROMIUM` at a Chromium binary you already have.

The tests run against the scripted adapter and car in [`src/core/simulator.ts`](src/core/simulator.ts), the same one the `simulate` command serves.

## Deployment

The app is published as a GitHub Pages project site at <https://mearman.github.io/obd/> by [`pages.yml`](.github/workflows/pages.yml), on every push to `main`. Service workers, Web Serial, WebUSB and Web Bluetooth need a secure context, so the site is only useful over HTTPS (or `localhost`); Pages provides that. Open the URL in Chromium and use the browser's install option to add it as an app, which then reloads offline from its service worker.

The build reads one environment variable, `BASE_PATH`, in [`app/base-path.ts`](app/base-path.ts): Vite's `base`, the manifest's `id`, `scope` and `start_url`, and so the service worker's scope all follow it. It defaults to `/` for local use and previews, and the workflow sets `BASE_PATH=/obd/`. A fork publishing its own project site sets `BASE_PATH` in `pages.yml` to its repository name (`/<repository>/`), and enables Pages with the source set to GitHub Actions. The workflow skips itself in a private repository.

## Releases

A release is made by bumping `version` in the root [`package.json`](package.json) and in [`app/package.json`](app/package.json) (a test checks they match) in a pull request. When it merges to `main`, [`release.yml`](.github/workflows/release.yml) reads the version, and if the tag `v<version>` does not exist it creates the tag and a GitHub release with generated notes; a push that leaves the version unchanged does nothing. [`scripts/release-needed.ts`](scripts/release-needed.ts) holds that decision. The workflow uses the default `GITHUB_TOKEN` with `contents: write` and publishes nothing to a registry.

The app shows its version in the top bar as a link to that release. The version is read from the root `package.json` when the app is built, so it needs no network, and the link opens the release page in a new tab (which cannot load offline).

## Licence

MIT. See [LICENSE](LICENSE).
