# obd-read

Read a car's diagnostics through an ELM327-style adapter, from a Node command line or from an installable, offline, responsive web app (a PWA), with software you can read and change.

`obd-read` talks to the control units behind the diagnostic socket: it reads their identification, stored fault codes and freeze frames. It can also clear a unit's fault codes, after saving what it is about to erase, and send a coding or adaptation write or an actuator test that you supply byte for byte, under the safeguards in [Writes and actuator tests](#writes-and-actuator-tests). Reads are the default: every request passes one guard, which refuses anything else without a single-use token. Security access, flashing and programming are not implemented. The TopScan route (TOPDON's proprietary dongle) is not supported; [issue 3](https://github.com/Mearman/obd/issues/3) records what driving one would take.

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
| `obd-read/plans`       | The shipped recording plans (`builtinPlans`, `loadBuiltinPlan`, and `shippedPlans` for a diagnostics service). See [Recording plans](#recording-plans).                                                    |
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
| `live [<unit>]`                                             | Named live values, once or repeatedly. With no unit it reads the legislated values the car supports (`--list` shows their names); with a unit and `--profile` it reads the named values the profile defines for that unit. `--values a,b` picks some, `--count` and `--interval` repeat the read, `--csv <file>` or `--tsv <file>` logs each sample to a new file (an existing file is never overwritten).                                |
| `battery`                                                   | Logs the adapter's own voltage reading at a fixed interval (`--interval`, `--duration`), printing each sample and a summary, and writing a new CSV or TSV with `--csv <file>` or `--tsv <file>`. It reads `ATRV`, or `STVR` (with `--precision` decimals) on an adapter that has the STN extensions, and needs no profile and no car bus.                                                                                                 |
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
| `capture --output <file>`                                   | Every raw request and reply the read-only services give, to decode later under any profile. See [Capture and decode](#capture-and-decode). TypeScript only.                                                                                                                                                                                                                                                                               |
| `decode <capture>`                                          | What a capture file says under `--profile`, or under none. Needs no adapter. TypeScript only.                                                                                                                                                                                                                                                                                                                                             |
| `import-capture <file> --output <file>`                     | Turns a saved scan or a `--log` transcript into a capture file. Needs no adapter. TypeScript only.                                                                                                                                                                                                                                                                                                                                        |
| `share <file>`                                              | Makes a link that shares a saved scan or a run's JSON, CSV or TSV export, or with `--open <link>` prints what a link carries. Needs no adapter. TypeScript only. See [Sharing](#sharing).                                                                                                                                                                                                                                                 |
| `record --plan <plan> --output <file>`                      | Runs a recording plan: guided phases, each with an instruction, a condition to wait for and reads at its start and end, written as a run's JSON export for `share`. See [Recording plans](#recording-plans). TypeScript only.                                                                                                                                                                                                             |
| `plan list`, `plan show <plan>`, `plan validate <file>...`  | Lists the shipped recording plans, prints one plan's phases, or validates plan files. Needs no adapter. TypeScript only.                                                                                                                                                                                                                                                                                                                  |
| `write <unit> --request <hex> --read <hex> --save <file>`   | Writes one coding or adaptation value you supply, after saving the value it replaces.                                                                                                                                                                                                                                                                                                                                                     |
| `restore <unit> --snapshot <file> --save <file>`            | Writes back the value a `write` saved.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `actuate <unit> --request <hex> --stop <hex> --seconds <n>` | Drives one actuator with a request you supply, then always sends your stop request.                                                                                                                                                                                                                                                                                                                                                       |

Every command that talks to a car takes `--adapter`, and `--log <file>` to keep the full exchange with the adapter. All except `obd`, `discover`, `clear-codes` and `battery` take `--profile`; for `live`, `mqtt`, `capture` and `record` it is optional. Exit statuses: 0 on success, 1 for a command that failed or reported an `error:`, 2 for arguments the parser rejects, 130 after an interrupt. A snapshot, a CSV log, a monitor log and a draft profile are created exclusively and never replaced.

The `obd` command asks a car only for what it says it supports: the supported-identifier bitmaps decide which values are requested. The decoding follows SAE J1979. Mode 06 test meanings other than the misfire counters differ per maker, so those results are printed with their raw value, limits and scaling identifier and marked as unconfirmed.

Fault codes are printed as the unit reports them: hexadecimal code bytes and a status byte. `describe` adds names to them afterwards: the generic OBD-II titles in [`src/data/obdex-generic.json`](src/data/obdex-generic.json), which are the English titles from [OBDex](https://github.com/foerbsnavi/OBDex) (CC0 1.0), vendored rather than fetched so that the tool works offline in a garage and rebuilt by [`scripts/vendor-obdex.ts`](scripts/vendor-obdex.ts), plus names from a definition file you import with `import-names`.

## Tabular formats

Wherever the data is a table, the tool writes CSV, TSV and JSON, from one writer (`src/core/tabular.ts`) and one definition of each table's columns (`src/core/tabular-views.ts`, `src/core/run-export.ts`), so the app's downloads and the command line cannot drift apart. Both delimited formats are UTF-8 with a header row, and nothing is escaped for spreadsheets: a value that starts with `=`, `+`, `-` or `@` is written as it is.

CSV is RFC 4180: fields are separated by commas, a field holding a comma, a double quote, a carriage return or a line feed is wrapped in double quotes with each quote doubled, and every record ends with CRLF. TSV separates fields with a tab and ends every record with LF. A TSV field is never quoted: a tab is written as `\t`, a line feed as `\n`, a carriage return as `\r` and a backslash as `\\`, every other character as it is, and a backslash followed by anything else is an error when the file is read. JSON is an array with one object per row, keyed by the column headers, every value a string.

The tables:

| Table          | Columns                                                               | One row per                                                                              |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Run            | `time`, `elapsed (s)`, then one `signal (unit)` column per signal     | timestamp                                                                                |
| Fault codes    | `unit`, `code`, `status`, `description`                               | stored code (for a generic OBD-II read the status is `stored`, `pending` or `permanent`) |
| Identification | `unit`, `label`, `hex`, `text`                                        | identification value                                                                     |
| Decoded values | `time`, `unit`, `name`, `label`, `reading`, `measure`, `error`        | value decoded from a capture, timed by the exchange it came from                         |
| Raw exchanges  | `time`, `request id`, `request`, `response id`, `response`, `outcome` | sender's reply to a request, or the request alone when nothing replied                   |

On the command line, `live` and `battery` log to `--csv <file>` or `--tsv <file>`. `probe`, `ident`, `faults`, `freeze`, `scan` and `obd` take `--format json|csv|tsv` and print the fault-code table, or with `--table identification` the identification values, instead of their text; the adapter lines and notes then go to standard error, and `--output` cannot be combined with it. `decode` takes the same `--format` with `--table values|faults|identification|exchanges` (values by default). Without `--format` every command prints what it always did. A fault code's description comes from the profile's names where it has one and from the generic titles for a generic OBD-II read.

In the app, a run in the Library exports CSV, TSV or JSON; a saved report offers its fault codes and identification values as CSV and TSV beside Download JSON; a capture's viewer offers the decoded values, fault codes, identification values and raw exchanges as CSV and TSV beside the capture export.

A run's CSV or TSV export reads back as a run: the Library's Import a file button and a file dropped anywhere on the Library keep it as a stopped run with the origin Imported, and `share` takes the file in place of a run's JSON export. The header must be exactly `time`, `elapsed (s)` and then one column per signal, and a file that is not is refused with the first column that differs. A cell that is a plain number reads back as a number and any other text as text, and a signal's unit is the last parenthesised word of its title, so a text reading that looks like a number, or a unitless signal whose own name ends in a parenthesised word, does not read back as written. Captures are not imported from a table, because a table has lost their structure; import them from their JSON, a saved scan or a transcript.

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

The shipped profiles are `mercedes-w211`, `toyota-tnga` (Toyota and Lexus TNGA and TSS2 cars from about 2016, mixing KWP2000 service 21 and UDS service 22, from the sources in [docs/vehicles/japan-korea.md](docs/vehicles/japan-korea.md)), `toyota-etnga` (the e-TNGA bZ4X and Solterra on UDS service 22, the units two open sources agree on, with the Lexus RZ untested and the extended-addressed tyre pressure unit left out; same document), `vag-mqb`, two Ford HS-CAN profiles (`ford-focus` and `ford-ranger`, from US-market service manual pages, so unconfirmed on UK cars; the medium-speed units need an STN adapter and are not in them, see [docs/vehicles/ford-gm-stellantis.md](docs/vehicles/ford-gm-stellantis.md)), `hyundai-kia-genesis` (electric, hybrid and petrol or diesel Hyundai, Kia and Genesis cars on one table, with the secure gateway caution in [docs/vehicles/japan-korea.md](docs/vehicles/japan-korea.md)), `mazda-skyactiv` (Mazda SkyActiv cars on 11-bit CAN), `honda-acura-29bit` (Honda and Acura 29-bit `18DAxxF1` units, from open projects that describe mostly North American and Japanese cars, so a UK car may differ; both in [docs/vehicles/japan-korea.md](docs/vehicles/japan-korea.md)), two PSA profiles (`psa-uds` and `psa-kwp2000`, for Peugeot, Citroen, DS and Opel or Vauxhall cars on PSA platforms, split because the protocol belongs to the unit and not its identifier), `vw-up` (the e-Up, Citigo-e iV and Mii electric, from two community sources in [docs/vehicles/vag-group.md](docs/vehicles/vag-group.md)), five Renault Alliance profiles (below) and three BMW profiles that use extended addressing over the OBD socket's CAN (D-CAN): `bmw-f-fem` (F-series cars with a front electronics module), `bmw-i3` (i3 and i3s) and `bmw-g29` (Z4 G29 and Supra J29, engine only). Every one is unconfirmed until read from a car; [docs/vehicles/bmw-mini.md](docs/vehicles/bmw-mini.md) gives the sources. Three more cover Japanese makes, each unconfirmed until read from a car, with their sources and contradictions in [docs/vehicles/japan-korea.md](docs/vehicles/japan-korea.md): `nissan-leaf` (Leaf ZE0 and AZE0), `nissan-infiniti-can` (Qashqai J11, Juke F15 and X-Trail T32, with its 29-bit units marked by a per-unit `id_bits`) and `mitsubishi-phev-imiev` (Outlander PHEV, i-MiEV, C-Zero and iOn). Their units answer at response offsets other than 8, and each unit may carry its own `diagnostics` (protocol and session) because one car mixes KWP2000 service 21 and UDS service 22. A newer Nissan with a secure gateway may stay silent, which is reported as no response. No source shows a Leaf, Qashqai, Juke, X-Trail or Mitsubishi unit accepting the session these profiles open: opendbc sends `10 81` then `21 83` only for software-version fingerprinting, OBDb's Leaf file sets `diagnosticLevel` `C0` (which the guard does not allow), and the Mitsubishi sources open no session, so 0x81 there is only a guard-permitted placeholder; confirming it on a real car is [issue 70](https://github.com/Mearman/obd/issues/70). BMW and Mini families without a profile, and the confirmation each BMW profile needs, are deferred issues:

- E-series on D-CAN, which the core can reach but no source names the units for: [issue 17](https://github.com/Mearman/obd/issues/17)
- K-line cars (DS2, KWP2000 on K-line), which need a K+DCAN cable and a DS2 transport: [issue 18](https://github.com/Mearman/obd/issues/18)
- F and G series over ENET (HSFZ), which an ELM327 or STN adapter cannot reach: [issue 19](https://github.com/Mearman/obd/issues/19)
- F-series without a front electronics module: [issue 21](https://github.com/Mearman/obd/issues/21)
- Mini: [issue 24](https://github.com/Mearman/obd/issues/24)
- Confirming `bmw-f-fem`, `bmw-i3` and `bmw-g29` on a car: [issue 20](https://github.com/Mearman/obd/issues/20), [issue 22](https://github.com/Mearman/obd/issues/22) and [issue 23](https://github.com/Mearman/obd/issues/23)

`mercedes-w203-w209` covers the C-Class W203 and the CLK W209 on the same CAN-C KWP2000 addressing as `mercedes-w211`: the units from the KWP2000 request and response pairs of a decoded W203 and W209 CAN-C database, every one of which the same project's W211 table repeats. The interior (CAN-B) units are left out, as they are for the W211. Every row is unconfirmed until read from a car; [docs/vehicles/mercedes-benz.md](docs/vehicles/mercedes-benz.md) gives the source.

The PSA profiles hold one row per request and response pair from a community ECU table, with the families that share each pair named in its description; the unit behind a row is read from its identification, not inferred from the ID. Which protocol a unit speaks depends on its model, so a unit silent under one profile may answer under the other. AEE2004 and AEE2010 cars carry diagnostics on OBD pins 3 and 8, not the usual 6 and 14, so an ELM327 or STN adapter needs a pass-through adapter or cable, and one source advises a branded adapter rather than a clone. The diagnostic CAN is set to 500 kbit/s, which the better source gives; another reports 250 kbit/s for the bus on pins 6 and 14 (unconfirmed, [issue 38](https://github.com/Mearman/obd/issues/38)). NEA2020 cars are reported to use pins 6 and 14 for DoIP (Ethernet), which this tool cannot reach, and one source says classic CAN diagnostics are there too. Every row is unconfirmed; [docs/vehicles/europe-other.md](docs/vehicles/europe-other.md) gives the sources, contradictions and exclusions.

`mercedes-w204-w212` covers the powertrain units of the C-Class W204, GLK X204 and E-Class W212: the engine and transmission, which OBDb's response records show answering at 0x7E0 and 0x7E1 on cars of those chassis, and four transmission-side units from a W204 powertrain sub-bus database. It opens KWP2000 session `10 92` like `mercedes-w211`, which the records support for one GLK transmission only; units that answered only service 22 may refuse it. Every row is unconfirmed until read from a car; [docs/vehicles/mercedes-benz.md](docs/vehicles/mercedes-benz.md) gives the sources.

A unit may also carry `id_bits` (11 or 29), the width of its own CAN identifiers, for a car that mixes the two on one socket: the bus `id_bits` is the default and a unit with its own width makes the session switch the adapter between the 11-bit and 29-bit protocols at the bit rate already selected, so a unit with 29-bit identifiers needs no second profile. The check reads each identifier against its own unit's width.

The five Renault Alliance profiles are `renault-zoe-ph1`, `renault-zoe-ph2` (11-bit and 29-bit units), `renault-twizy`, `renault-twingo-smart-453` (Twingo III and smart 453, with the security gateway on 29-bit identifiers) and `renault-dacia-core` (ten core units for Clio IV and V, Captur, Megane IV, Duster and Sandero, and the Mercedes-Benz Citan W415, which ddt4all lists on the same address plan, scoped to cars up to about the 2018 model year, which is an inference). Their address tables come from the CanZE ECU files and the ddt4all address table, and every row is unconfirmed until read from a car. Renault fits a security gateway to recent cars: a silent unit is reported as no response, not as absent, and nothing is known about what the gateway filters. [docs/vehicles/europe-other.md](docs/vehicles/europe-other.md) lists the sources opened, what is confirmed and what is only reported.

`mercedes-mfa` covers the Mercedes-Benz MFA compact cars (W176 A-Class, W246 B-Class, C117 CLA and X156 GLA): UDS over the OBD socket's 11-bit CAN in session 0x03, with most units replying on 0x4xx identifiers rather than the request plus 8, so a clone adapter that only passes 0x7E8 to 0x7EF reaches the engine and little else. Its table comes from a community W176 catalogue, with the powertrain addresses corroborated by OBDb captures, and every row is unconfirmed until read from a car; [docs/vehicles/mercedes-compact.md](docs/vehicles/mercedes-compact.md) gives the sources and their limits. `mercedes-w169-w245` covers the W169 A-Class and W245 B-Class on KWP2000: the engine, whose address comes from one OBDb capture of a diesel car, and three further units named only by their identifiers, which answered an identifier sweep of one petrol A 150 read with this tool. Those four answered session 0x81, which the profile sets on each unit; the profile's default session 0x92 comes from a crowd-sourced wake-up table and is untested. No source says what the three further units are, and no source gives the other units ([issue 88](https://github.com/Mearman/obd/issues/88)). The W168 A-Class has no source and no profile ([issue 89](https://github.com/Mearman/obd/issues/89)).

`mercedes-mra` covers the C-Class W205, E-Class W213 and S-Class W222 on 11-bit CAN with UDS: the brake unit on 0x7E2, the engine and transmission on 0x7E0 and 0x7E1, and a battery-reading unit on 0x7E5, from OBDb's response records for cars of those chassis. That these units speak UDS is inferred from their replies, not read in a source. Every row is unconfirmed until read from a car; [docs/vehicles/mercedes-benz.md](docs/vehicles/mercedes-benz.md) gives the records.

`jaguar-i-pace` covers the Jaguar I-PACE on 11-bit CAN with UDS: the high-voltage battery, charger, HVAC, tyre pressure, telematics, gear shift and powertrain units, each placed at the same address by OBDb and by the Open Vehicle Monitoring System's I-PACE module. The units only OVMS names are left out. Every row is unconfirmed until read from a car; [docs/vehicles/europe-other.md](docs/vehicles/europe-other.md) gives the sources and what each does not show.

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

The screens (Session, Library, Guide, Settings) use the oRPC client for the `DiagnosticsService` contract over a message port to a dedicated worker ([`app/src/service/`](app/src/service)). Session is everything done with one car on one connection, in four sections that follow it ([`app/src/session/`](app/src/session)): Connection opens a connection with a vehicle profile, or with none ("Generic OBD-II (no profile)", the default; see [Generic OBD-II sessions](#generic-obd-ii-sessions)), and once connected shrinks to a one-line summary of the adapter, the profile and the battery voltage read on connecting, with Disconnect; Read scans every unit, shows the faults, freeze frames and OBD-II report with each unit's guarded clear, and captures everything; Live starts and stops a collection run; Advanced, collapsed until opened, holds the other guarded operations (clearing every emissions code, a write and an actuator test). Each guarded operation is a dialog that shows what would be sent and the saved snapshot and sends nothing until "Send to the car". A section that needs a connection says so at its top with an Open Connection button, and its controls stay in view, disabled. The summary and a section navigation stay in a bar under the header as the page scrolls; on a phone the navigation shows one section at a time, and from 1024 px wide it shows or hides each section on its own, with Read and Live side by side. Collapsed sections and the Session screen itself stay mounted while hidden, so a scan's results, a run's table and anything typed into Advanced survive moving between sections and screens. The Library lists everything stored (see below); Guide runs a recording plan (see [The Guide screen](#the-guide-screen)); Settings imports a profile into the service's storage. The simulator is a selectable adapter (`simulator://<profile>`, or `simulator://generic-obd2` for a car with no profile), and every screen labels what it shows as "Simulated data".

The Library holds everything kept on this device in one list, newest first unless sorted otherwise: collection runs, raw captures and saved reports (each scan, OBD-II read and snapshot, including those saved from a share link). Each row shows its kind, its date, the profile it was read with, its details and its origin. A search matches every word typed against what a row shows, a date range keeps the rows of its UTC days, and filters by kind (All, Runs, Captures, Reports) and by origin narrow the list further. A button in the Kind, Date, Profile and Origin headers sorts by that column and turns it around on a second press, and the list can be grouped by kind, origin or UTC day, each group under a heading that collapses it. The filters, search, dates, sort and grouping live in the address beside `screen` and `item` (`kind`, `origin`, `q`, `from`, `to`, `sort` with a leading `-` for descending, and `group`, each left out at its default), so a view has a link of its own, a reload keeps it and Back steps through each change; one edit of the search is one history entry, however many keys it took. Each kind keeps its own actions: a run views its graphs, shows its fault codes, shares its summary, exports CSV, TSV or JSON, and resumes or stops where it can; a capture opens in the capture viewer or is deleted; a saved report opens read-only with a Download JSON button that saves it exactly as `scan --output` or `obd --output` writes it, so `decode`, `share`, `compare` and `describe` read it, beside its CSV and TSV downloads. One Import a file button, and a file dropped anywhere on the Library, tell the file's kind from its content: a run's CSV or TSV export becomes an imported run, and a capture, a saved scan or an adapter transcript an imported capture, which opens in the viewer. A run's JSON export, a recording plan and a vehicle profile are refused with where each belongs, since profiles are imported in Settings and plans open on the Guide screen. The list and its row actions are in [`app/src/library/`](app/src/library).

The Library opens a stored run as graphs: one chart per signal on a shared time axis, drawn as plain SVG with no charting dependency, each with labelled axes, its unit, its lowest and highest value and a text summary of the drawing for assistive technology. A cursor moves across every chart at once and each chart writes the value at the cursor beside its name, a table repeats those values as text, and playback runs the cursor at 1x, 2x or 4x with a scrubber, a play and pause button and the keyboard (Space plays and pauses, the arrow keys step between readings, Home and End jump to the ends). The service's samples are read a page at a time and thinned as they arrive, keeping each signal's extremes, so a long run never puts more than a bounded number of points in memory or in the page. The Session screen's Live section draws a rolling trend beside each value while a run collects, and a shared run summary uses the same chart for its trends. The chart component and its pure scaling, thinning and cursor-lookup functions are in [`app/src/charts/`](app/src/charts).

Build the package first, because the app imports it through its built exports, then work in the app:

```sh
pnpm install
pnpm build
pnpm --filter obd-read-app dev
```

### Storage and the service boundary

Storage is a `Storage` interface in core. Its implementations are an in-memory one, SQLite through Drizzle over `node:sqlite` in Node (`openNodeStorage`), and sqlite-wasm on the Origin Private File System in the browser, where a dedicated module worker owns the database and the page posts SQL to it (`openWorkerStorage`). Drizzle stays behind `Storage`: the SQL migrations `drizzle-kit` generates from [`src/storage/schema.ts`](src/storage/schema.ts) are embedded in `src/storage/migrations.ts` so a browser build needs no file access. After changing the schema run `pnpm storage:generate`; a test fails when the embedded module and the migration folder disagree.

Every run, saved report and capture has an `origin` column: `local` when this device read it from an adapter, `shared` when it was saved from a share link, `imported` when it was read from a file (a capture imported in the Library or through `captures.import`). Storage records it as the caller says (`origin` on `createRun` and `saveScanReport`, defaulting to `local`, and a required argument of `saveCapture`), returns it on every record and summary, and the list calls filter by it. The migration that added the column marks a capture of kind `import` as imported and a scan report under the adapter `shared://link` (how the app saved a shared scan before) as shared; everything else stays local. Only a local record takes write-type actions: the service refuses `runs.resume` for a shared or imported run with `CONFLICT`, and the Library does not offer Resume for one. The Library shows each record's origin as a badge, with a filter by it, and the capture viewer and an opened report show it too.

The worker (`app/src/database/`) holds an exclusive Web Lock, installs sqlite-wasm's `opfs-sahpool` VFS (which needs no cross-origin-isolation headers), applies the migrations and asks for persistent storage. Settings exports the database as a `.sqlite` file and imports one, checked in a scratch database before it replaces anything.

That VFS allows one connection, so tabs and windows of the app share the one connection instead of each opening the database ([`tab-share.ts`](app/src/database/tab-share.ts)). The tab whose worker holds the lock is the leader and opens the database; every other tab's worker waits in the lock's queue, and that tab's `Storage` and database controls send each call to the leader over a `BroadcastChannel` and return the answer, so every tab reads, writes and saves received links to the same data. When the leader closes or crashes the browser grants the lock to the next waiting worker, that tab opens the database and announces itself, and the other tabs send it their unanswered calls. The leader acknowledges a call before running it: a call it never acknowledged is sent again, a call it acknowledged but did not answer is sent again only when running it twice leaves the same data, and otherwise (creating a run, saving a scan report, appending samples) it fails with a message saying the outcome is not known rather than risk storing it twice. After each write the leader tells every tab, and the screens that list stored records read them again. A run's collector stays in the tab that started or resumed it, which holds a Web Lock for that run, so no other tab resumes a run while that tab is open. A tab that holds the lock without answering (one running an older version) is reported as such, with a retry, and a browser without the Web Locks API or the Origin Private File System is told why nothing will be saved.

The service boundary is an oRPC contract, `DiagnosticsService` in [`src/core/service.ts`](src/core/service.ts), served and consumed over a message port (`serveDiagnostics`, `connectDiagnostics`). Contract suites run the same tests against every `Storage` implementation and against the service in process and over a message port.

### Generic OBD-II sessions

`link.connect` and `runs.start` take an optional `profile`. With none the connection is generic: it speaks only the legislated OBD-II services (SAE J1979), on the 11-bit 500 kbit/s CAN settings the `obd` command defaults to, and selects the bus explicitly, as `obd` does, instead of using the adapter's automatic protocol detection. `scan.run` returns the structured OBD report in `obd` (VIN, per-unit lamp, stored, pending and permanent codes, readiness, freeze frame, the supported live values, mode 06 results and calibration identifiers) and the same data as one unit report per answering emissions unit in `units`. A run with no profile collects the legislated values the car supports and is stored under the reserved profile name `generic-obd2`, which a profile import may not use; its scan reports and clear snapshots carry the same name. `clear.request` with `{ kind: "obd" }` is the only change a generic session can make, through the same snapshot, confirmation and clear token as before. Everything that addresses one control unit (`link.probe`, `units.*`, a unit `clear`, `write`, `actuate`, a run naming a `unit`) rejects with the error code `PROFILE_REQUIRED` before anything is sent, saved or parked, and the app disables those controls with the reason. Every request still passes the guard, whose OBD-II table allows modes `01`, `02`, `03`, `06`, `07`, `09` and `0A`, and mode `04` only with a clear token. The app does not suggest a profile after reading the VIN, because a profile carries no manufacturer identifier or model hint to match it against.

### The service host

`createDiagnosticsService` (core) wires what an edge needs: a `DeviceLink` (the one adapter connection, with a lock so a scan, a poll and a guarded operation never interleave), a `LiveCollector` and the `DiagnosticsHost` whose router is served over a message port or a socket. The edge supplies `Storage`, a `TransportHost`, a profile loader and the shipped recording plans (`shippedPlans` from `obd-read/plans`); a test may also give a `planClock`.

- Reads: `link.connect`, `link.probe`, `units.ident`, `units.faults`, `units.freeze`, `scan.run` (saved as a scan report), `battery.voltage`, `monitor.capture` (listen-only; needs the adapter free) and `reports.list` and `reports.get`.
- Changes to the car are two calls each. `clear.request`, `write.request` and `actuate.request` run the existing command until it would ask for a typed `yes`, and return what it printed (what would be sent), the saved snapshot and a confirmation id. `clear.confirm`, `write.confirm` and `actuate.confirm` answer yes, and `guarded.cancel` answers no. The guard's single-use tokens exist only inside the commands the host runs. The confirmation id is a handle to a parked command, not a token: it passes once, belongs to one kind of operation, expires, and only one can be pending, because the parked command holds the adapter. No client mints or holds anything that authorises a request.
- Collection: `runs.values`, `runs.start`, `runs.stop`, `runs.resume`, `runs.status`, `live.samples` (an async iterator) and the stored-run reads and exports. `runs.values` lists the legislated values the car supports and times one request of the adapter. A run polls either a unit's named profile values (`unit`) or the legislated values the car supports, narrowed by `signals` when given, and stores readings in batches; `runs.status` reports which value of the round is being requested. Stopping a run ends the round before its next request, so the run ends within the request in flight, and the values not yet read in that round are left out. When the link drops (a transport or adapter error) the collector reconnects with exponential backoff and carries on; any other error ends collection as `failed` and leaves the run open. After a reload the run record and its samples remain in storage and `runs.resume` collects into the same run again. A run's selection of unit and values is kept as a final line of its notes until `Storage` has a field for it. One run holds the adapter at a time, and while it does the other adapter operations refuse. A run of all the legislated values also reads the stored, pending and permanent fault codes when it starts, every so often and when it stops, and records each list as a text sample (`stored fault codes`, `pending fault codes`, `permanent fault codes`) whenever it changes, so the exports and the live table carry them; `faultEvents` turns those samples into when each code appeared and disappeared. A time is when a poll saw the change, not when the car set or cleared the code. A run of one unit's profile values, or one that names the signals it wants, reads no fault codes.
- Recording plans: `plans.list`, `plans.start`, `plans.status`, `plans.events`, `plans.confirm`, `plans.skip`, `plans.abort` and `plans.recover`. See [Running a plan through the service](#running-a-plan-through-the-service).
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

`vite-plugin-pwa` precaches the whole shell, the bundled profiles, the database worker and the SQLite `.wasm` file, and generates the manifest and icons from [`app/public/icon.svg`](app/public/icon.svg) at build time. After the first load the app starts and opens its stored data with no network. The app makes no runtime network requests (an ESLint rule forbids `fetch`, `XMLHttpRequest` and `WebSocket` in `app/src/`), loads no CDN scripts and no web fonts.

#### Updates

An open tab asks the browser to look for a new service worker every hour, whenever the tab becomes visible again and whenever the browser comes back online, as well as on each load; browsers alone look only on navigation and about once a day, so a tab left open would otherwise keep old code, and a tab on an older version cannot share the database with newer ones. A new version is applied without asking once nothing is running in the tab: no collection run, recording plan, scan, operation on the car, import, export, shared-link save or database call (one the tab made, or one it is running for another tab while it holds the database) is in flight. Until then the toast says a new version is ready, and Reload applies it at once; dismissing the toast does not stop the later automatic update. Each part of the app that runs such work marks it in an activity registry (`app/src/pwa/activity.ts`, through the `useActivity` hook), so new kinds of work join the check by marking themselves. Tabs announce their version to each other on a dedicated `BroadcastChannel` when they start and when they become visible, and a newer tab answers an older one; an older tab that hears of a newer version looks for the update at once and, when idle, takes it, or reloads onto it when the newer service worker has already taken over. It reloads at most once for a given version, so a tab that comes back on the same old version is never sent round a loop. A tab told that its database is held by a tab that cannot share opens it again when a tab on its own version appears. Settings shows the running version, when the tab last checked and why a check failed, with a Check now button. The logic is in [`app/src/pwa/updater.ts`](app/src/pwa/updater.ts) and takes its clock, registration, page signals, activity registry and channel as arguments, so it is tested without a browser.

### Background collection

The Live section first asks the car which legislated values it supports and offers them as a checklist under the headings Engine, Fuel and mixture, Emissions and catalyst, Electrical, and Counters and status, with the presets Engine, Fuel and mixture and Everything and an estimate of how long one round takes from the adapter's measured time per request; the choice is remembered in the browser. While a run collects it shows which value it is reading until the first readings arrive, then the readings grouped under the same headings with a search box and a pin toggle that keeps pinned values at the top (also remembered). Readings are rounded for display by their unit and stay exact in storage and in exports, counters that sit at the largest value their field can carry say the real value is higher, and Stop collecting shows Stopping at once. The Live section lists the fault code changes of the run being collected, and each run in the Library has a Fault codes button for its history. Collection continues while the app is open, in the foreground or in a background tab the browser has not frozen. No web API guarantees collection in the background: with the screen off or the app closed, Android may suspend or stop it, and a Web Bluetooth connection is held by the page, not by the service worker or the operating system. The collector runs in a dedicated worker so a busy page does not delay a poll, the app asks for a screen wake lock while a run collects or a plan runs, reconnects when the link drops and resumes a run after a reload, but none of that overrides the browser. A guaranteed unattended recorder is the Node command line (`live --csv`, `battery --csv`, `mqtt`) on a machine that stays on, such as a Raspberry Pi. Android Auto is not a target for the PWA.

### Browser support

Chrome and Edge, on Android and desktop. Safari, Firefox and every iOS browser (all WebKit) have no Web Serial, Web Bluetooth or WebUSB, so the app cannot reach an adapter there; the Session screen's Connection section says why. The shell itself loads in any modern browser.

## Capture and decode

A scan report keeps what one profile made of the car's replies. A capture keeps the replies themselves, so the same visit to the car can be read again later under a different profile, a newer version of the same profile, or no profile at all, without going back to the car.

A capture (`format: "obd-read-capture"`, `version: 1`, defined by `captureSchema` in [`src/core/capture.ts`](src/core/capture.ts)) holds one entry per request: its sequence number and time, the bus (CAN width and bit rate, or the K-line scheme), the addressing (a broadcast, one unit by request and response identifier with its ISO 15765-2 extended address when it has one, or a sweep that accepts any reply), the protocol, the request bytes, and the raw reply messages by sender, a negative response's bytes, or the adapter's or link's error text. It also records the adapter's identity, the program and its version, and how the capture was made. It stores no decoded value. A file is refused above 32 MiB of text, 100,000 exchanges or a message longer than ISO 15765-2 carries, and a compressed file is refused if it would inflate past that.

`capture` reads, recording every exchange:

1. The legislated OBD-II reads, for everything the car's supported-identifier bitmaps list.
2. With `--profile`, the identification, fault codes and freeze frames of every unit of the profile, units reached with an extended address included. Without one, a sweep of request identifiers `--discover-first` to `--discover-last` (default `0x700` to `0x7FF`, as `discover` does) with the UDS and KWP2000 default sessions, then the same reads of every unit that answered.
3. Only with `--sweep`, every data identifier from `--sweep-first` to `--sweep-last` on each unit that answered, through the read-data service (UDS `22`, KWP2000 `21`), at most `--sweep-budget` requests (default 2000, at most 20,000) with `--sweep-pause` milliseconds before each (default 50, at least 10).

Every request goes through the guard with no token, so a capture can only read: it never writes, actuates, clears or opens security access. Ctrl-C stops it after the request in flight and the file is still written, marked incomplete. The output file must not exist.

An identifier sweep sends many requests, one after another. Some units answer slowly or not at all to identifiers they do not have, and some log the requests in their own memory. Keep the range narrow, and stop the sweep if the car reacts.

`decode` replays a capture through the same readers the live commands use, so a capture decodes to exactly what the live command printed. `--profile` takes a shipped name or a `.json` file; without it only the legislated reads are decoded. A unit the capture holds nothing for is reported as not in this capture, and every exchange no reader used is listed at the end with its address and raw bytes, never dropped. The live `scan`, `probe`, `ident`, `faults`, `freeze` and `obd` commands report through this same decoding of their own exchanges.

```sh
obd-read capture --adapter <url> --profile mercedes-w211 --output car.obdcap.json
obd-read decode car.obdcap.json --profile mercedes-w211
obd-read decode car.obdcap.json --profile ./my-updated-profile.json
obd-read decode car.obdcap.json
obd-read import-capture scan.json --output scan.obdcap.json
obd-read import-capture run.log --output run.obdcap.json
```

`import-capture` recovers the exchanges of a saved scan (from the transcript it carries) or a `--log` transcript, by following the adapter commands that set the bus and addressing. It lists what it cannot recover rather than guessing: K-line requests, lines that are not requests, replies with no request before them and lines whose time cannot be read. A saved scan with no transcript cannot be turned back into exchanges; its decoded units stay in the scan file.

The app has a Capture everything card in the Session screen's Read section, and the Library lists stored captures, imports a capture file, a saved scan or a transcript (from its Import a file button, or by dropping the file anywhere on the Library), and opens a viewer; a capture taken with Capture everything opens there at once. The viewer decodes the capture with the profile chosen in its selector (every shipped and imported profile, and Generic), counts what that profile decoded and what it left raw, and lists the raw exchanges. Above the tables sits a playback panel, in the viewer and in a shared capture's viewer: a strip marks each stretch of the capture, with refused replies and unanswered requests marked by shape and by word as well as by colour, a scrubber moves a cursor through the exchanges, and Play, Pause, Step, 1x, 2x and 4x replay them with each gap between exchanges kept between a floor and a ceiling so a burst recorded in one instant is still watchable. Space, the arrow keys, Page Up, Page Down, Home and End drive it from the scrubber, and a live region announces the exchange at the cursor. The exchange list and the decoded tables then show the capture as it stood at the cursor, each value as last read (`captures.decode` takes an optional `exchanges` count for this, and `decodeAsOf` in the core package does the same), and Show everything, which is on at the end of the capture, restores the whole decoding. Playback replays stored data only and sends nothing to an adapter. Importing a profile from the viewer, or on Settings, decodes the capture again with it. A capture exports as `.obdcap.json`, or `.obdcap.json.gz` compressed, which is about a tenth of the size.

Captures are stored in the app's database as one compressed document each, with an index of the addresses each one reached. The viewer has two Share buttons: Share the raw capture makes a capture link that carries every exchange, so the receiver decodes it with a profile of their choosing, and Share this decoding shares the current decoding as a scan or OBD-II report link. Both are within the limits in [Sharing](#sharing); a capture too large for a link is passed on as the exported file.

A capture holds the VIN, every unit's identification and the fault history, like a saved scan. It stays on the device that made it, in the database or the file you write, until you export or share it.

## Recording plans

A recording plan turns a test done by hand into steps the program leads: each phase tells the person what to do, records the values while they do it, waits for a condition that shows the step is done, and reads the fault codes, freeze frame or misfire counters at its start and end. The run it records knows which phase each reading belongs to.

The person does all the driving and the pedal work. A plan only reads: it uses the legislated OBD-II read services (current data, freeze frame, stored, pending and permanent codes, and the mode 06 misfire monitors), each through the guard, and has no step that clears, writes or actuates. Every pedal phase in the shipped plans is done parked, handbrake on, in neutral or P, in a ventilated space, and a driving phase on a safe road.

### The plan file

A plan is a JSON file named `*.obdplan.json`, defined by `planSchema` in [`src/core/plan.ts`](src/core/plan.ts) and validated with Zod when it is loaded:

```json
{
  "format": "obd-read-plan",
  "version": 1,
  "name": "idle-then-blip",
  "title": "Idle, then blip",
  "description": "Idles for a minute, then one quick blip. The person works the pedal, parked.",
  "source": "Why the plan is shaped as it is, or where the procedure comes from.",
  "needs": { "values": ["engine-speed", "coolant-temperature"] },
  "phases": [
    {
      "id": "idle",
      "title": "Idle",
      "instruction": "Parked, handbrake on, in neutral or P: let the engine idle.",
      "sample": { "every": 1 },
      "reads": { "start": ["stored-codes"], "end": ["stored-codes", "pending-codes"] },
      "end": { "when": { "kind": "elapsed", "seconds": 60 }, "timeout": 90, "onTimeout": "skip" }
    },
    {
      "id": "blip",
      "title": "Blip",
      "instruction": "Parked, handbrake on, in neutral or P: press the pedal briskly past 3000 rpm, then release it.",
      "sample": { "values": ["engine-speed"], "every": "fastest" },
      "repeat": { "times": 3 },
      "start": { "when": { "kind": "value", "value": "engine-speed", "op": ">", "than": 3000 } },
      "end": {
        "when": { "kind": "value", "value": "engine-speed", "op": "<", "than": 1200, "for": 2 }
      }
    }
  ]
}
```

`safety` is optional text about staying safe at the car, kept in view while the plan runs in place of the description. `revision` optionally counts the plan's edits from 1; with the plan's digest, the SHA-256 of its canonical JSON with every default filled in (`planDigest`), it labels which version of a plan a run followed, shown as `revision 3, a1b2c3d4e5f6`. A plan has at most `MAX_PLAN_PHASES` phases and nests `any` and `all` at most `MAX_CONDITION_DEPTH` deep.

`needs.values` lists the legislated values to read, by the names `live --list` prints (such as `engine-speed`), or is `"all"` for every value the car supports; `needs.profile` optionally names the profile the run is recorded for. A phase has an `id`, a `title`, a single-line `instruction`, what to `sample` (a subset of the values, and `every` so many seconds or `"fastest"` for one read after another), the `reads` to take at its `start` and `end` (`stored-codes`, `pending-codes`, `permanent-codes`, `freeze-frame`, `misfire-counters`), `watchCodes` to read the code lists throughout and record each change, an `end` wait and an optional `start` wait, and an optional `repeat`: `{ "times": n }`, or `{ "until": <condition>, "max": n }` checked at the end of each pass.

### Conditions

A condition is data, never code: the runner evaluates it and nothing in a plan is executed.

| Condition                                                                        | Holds when                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `{ "kind": "elapsed", "seconds": n }`                                            | n seconds have passed since the wait began.                                                                 |
| `{ "kind": "samples", "count": n }`                                              | n samples have been taken since the wait began.                                                             |
| `{ "kind": "value", "value": v, "op": ">", "than": n, "for": s }`                | The value compares with n (`>`, `>=`, `<`, `<=`), on every sample for s seconds when `for` is given.        |
| `{ "kind": "value", "value": v, "op": "between", "min": a, "max": b, "for": s }` | The value is from a to b, on every sample for s seconds when `for` is given.                                |
| `{ "kind": "value", "value": v, "op": "stable", "within": x, "for": s }`         | The value's samples over the last s seconds spread by no more than x.                                       |
| `{ "kind": "code-appears", "list": "pending", "code": "P0300" }`                 | A code that was not in the list when the wait began appears in it; `list` and `code` are optional filters.  |
| `{ "kind": "code-clears", "list": "stored", "code": "P0420" }`                   | A code that was in the list when the wait began, or appeared since, is gone from it; both filters optional. |
| `{ "kind": "confirm", "prompt": "Ready?" }`                                      | The person confirms: Enter at the command line, a button in a page.                                         |
| `{ "kind": "any", "of": [...] }`, `{ "kind": "all", "of": [...] }`               | Any one, or every one, of the conditions holds.                                                             |

A value condition tests the value's first reading; most values have only one. A code condition makes the phase read the code lists while it waits.

### The timeout rule

Every wait has a `timeout` in seconds, `DEFAULT_WAIT_TIMEOUT_S` when it gives none, and an `onTimeout` of `skip` (end the phase, take its end reads, go on) or `fail` (end the plan as failed), `fail` when it gives none. A timeout no longer than the condition itself needs (the seconds of `elapsed`, the `for` of a value condition) is refused, so no wait can hang. A value name that is not a legislated value is refused when the plan is loaded, with the list of valid names, and a value the car does not report is refused before the run starts, with the values it does report.

### Shipped plans

| Plan                 | What it records                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cold-start-warm-up` | From ignition on through a cold start and idling until coolant temperature holds within 2 °C for two minutes, with the code lists read at the start and the end. |
| `idle-then-rev`      | A minute at idle, a minute held between 2000 and 2500 rpm, half a minute at idle, then three quick blips, with the codes read at the end of each phase.          |
| `misfire-under-load` | An idle baseline, a minute of steady revs and three blips, with the mode 06 misfire counters read before and after each phase.                                   |
| `drive-cycle-watch`  | From moving off until the car has been stopped for half a minute, reading the code lists throughout and logging each code that appears or clears with its time.  |

Each plan's `source` field gives its reason or source; `obd-read plan show <plan>` prints it with every phase.

### The commands

```sh
obd-read plan list
obd-read plan show idle-then-rev
obd-read plan validate my-test.obdplan.json
obd-read record --adapter <url> --plan idle-then-rev --output idle.json --csv idle.csv
obd-read share idle.json
```

`record` loads and validates the plan and refuses an output file that exists before it opens the adapter. It prints a banner and the instruction for each phase, the condition it waits for with its timeout, a status line with the progress and the time left, each read's result and each code that appears or clears. A phase that asks the person to confirm prompts on the terminal; with no terminal the command refuses the plan before connecting, unless `--yes-confirm` confirms each such step at once. Ctrl-C aborts the plan, and the run is still written. `--csv <file>` or `--tsv <file>` also writes the run as a table, in the layout the other run exports use. The exit status is 0 when the plan completed, 1 when it failed and 130 after an interrupt.

### The run it records

A plan is stored as an ordinary run, so the run screens, the exports and `share` handle it as any other. Each reading is a sample under its value's label. Each fault code list is a text sample, under `stored fault codes`, `pending fault codes` or `permanent fault codes`, holding the sorted codes or `none`, written when the list changes. The plan itself, with every default filled in, is one text sample under `plan` at the run's start, so the run carries the exact version it followed; `planOfRun` reads it back. Each pass of each phase is one text sample under `plan phase`, at the phase's start, holding its record as JSON: the phase id and title, the pass, the start and end times, the outcome (`completed`, `timed-out`, `skipped`, `failed` or `aborted`) and every read with its result. `planPhases` in the core package reads them back.

### Running a plan from code

`PlanRunner` in the core package runs a plan over any `PlanLink` (a connected `DeviceLink` is one) into any `Storage`, and takes an injected `PlanClock` so a test runs a long plan at once. Construct it with the plan, link, storage, adapter label and an `onEvent` listener, then `await runner.run()`; `runner.confirm()`, `runner.skipPhase()` and `runner.abort()` act at its next step. The events, in order, are `plan-started`, `phase-started` (with the phase and its instruction), `waiting` (the condition in words and its timeout), `confirm-requested`, `sample`, `progress`, `code-appeared` and `code-cleared`, `read`, `condition-met` or `condition-timed-out`, `phase-finished` and `finished`.

### Running a plan through the service

The `DiagnosticsService` contract runs plans next to the `DeviceLink`, so in the app the runner runs in the worker with the transport, as collection does, and every read still passes the guard there; a plan has no step that clears, writes or actuates. `plans.list` returns the shipped plans. `plans.start` takes a shipped plan by name or the text of a plan file and validates it as `parsePlan` does, so an invalid plan is refused with `BAD_REQUEST` listing every problem and, for an unknown value name, the valid names. It needs a connection and the adapter free, returns once the run exists, and the run is stored and stopped as `record` stores it. While a plan runs, collection, captures, scans, guarded operations and disconnecting refuse with `CONFLICT`. `plans.events` is an async iterator of the runner's events: a late subscriber first gets what has happened (of samples and progress only the latest of the phase), then each new event, until `finished`. `plans.status` reports the state, the phase and whether a confirmation is awaited; `plans.confirm`, `plans.skip` and `plans.abort` act at the plan's next step.

A plan does not resume after a reload, because each phase depends on what the person was doing. The run records the plan's name on a final line of its notes, so `runs.resume` refuses it with `CONFLICT`. `plans.recover` takes the open runs a page may stop and stops each one a plan recorded, at its last reading, returning them. The app calls it at start-up, before it looks for a collection run to resume, with the open runs whose lock no other tab holds, so a plan recording in another tab carries on; a tab holds a run's lock while it records a plan into it, as it does while it collects one.

### The Guide screen

The app's Guide screen lists the shipped plans with their descriptions and imports a plan file with the button or by dropping it on the screen, showing every problem of an invalid file. The chosen plan is previewed phase by phase: title, instruction, what is sampled and how often, and when it starts and ends in words, with the timeout and what happens when it runs out. Each plan's own text about who does what at the car is shown apart, above the phases and while the plan runs. Start is disabled, with the reason, until an adapter is connected and no collection run holds it.

While a plan runs the screen shows the current phase in large type meant to be read from a phone propped in the car: the instruction, what the phase waits for, a countdown for a timed phase, the progress and a bar towards the timeout, and the values being sampled. A phase that asks the person to confirm shows a large confirm button; skip and abort are always offered. Each new phase is announced in a live region for assistive technology, by a short vibration where the device has one and, when "Read each new phase aloud" is on (it is off by default and remembered in this browser), by speech synthesis. Codes that appear or clear and waits that time out are listed with their times. The screen is kept awake while the plan runs, and the plan carries on while another screen is open. When it ends the screen summarises it: each phase with its outcome and how long it took, the codes each list held at the first and last read, and buttons to open the run's graphs in the Library, export it as CSV, TSV or JSON, send the results back as a link, or record another. A plan stopped by a reload is listed as stopped, with a way to its run.

### My plans and the plan editor

The Guide screen's My plans list holds the plans kept in the app's database, each marked with where it came from (made here, shared from a link or imported from a file) and its version. Each can be recorded, edited, duplicated, exported as a `.obdplan.json` file, shared as a link or deleted, and a plan file can be imported into the list. A kept plan is validated again whenever it is listed, so one that no longer validates shows its problems and cannot be chosen.

New plan and Edit open the plan editor, a form rather than raw JSON: the name, title, description, safety text and source; the values the plan reads, as a checklist of the same value names the Live picker uses; and the phases, which can be added, moved up and down and removed. Each phase has its title, instruction, the values it samples, the gap between samples or as fast as the car answers, the reads at its start and end, whether it watches the code lists, an optional start condition, its end condition and how it repeats. The condition builder covers every kind in the schema (after a number of seconds or samples, a value above, below or between numbers or holding steady, a code appearing or clearing, the person confirming, and any of or all of other conditions, nested), and every wait has a timeout and whether running out skips the phase or stops the plan. Every change is validated with `parsePlan`, the same check a plan passes before it runs, and each problem is shown beside the phase it is about; Save stays disabled until the plan is valid. Preview shows the plan exactly as the person recording it sees it, and JSON offers the plan's JSON for advanced edits, which must validate before it is used or saved. A saved edit that changes the plan raises its revision by one. The editor is operated by keyboard, its targets are at least 44 px and it fits from 320 px wide in both colour schemes.

### Sharing plans and their results

A plan is sent to someone to record as a link of kind `plan`, from Share link in My plans or with `obd-read plan share <plan name or file>`. The link carries the whole plan and is validated on opening by the plan schema itself: it names only legislated values, waits only with a timeout and reads only through the read-only services, so a link cannot make a plan that clears, writes or actuates, and an invalid one lists every problem and offers nothing to run. Opened in the app, it shows the plan read-only, labelled as shared from a link: its title, version, safety text, description and each phase's instruction, what it samples and when it ends in words. Open in Guide keeps it in My plans, marked as shared, and opens the Guide screen with it chosen, ready to record; Save to my plans keeps it without leaving the link. The same plan saved from links twice is kept once.

When the recording ends, the Guide summary offers Send results back. Its link, of kind `plan-result`, is self-contained: it carries the whole plan with its digest (which must match it), the run's summary (at most 120 readings of each signal), each phase pass with its start, end, outcome and the reads it took, and every fault code that appeared or cleared, with times from the run's start. A run summary link cannot carry these, since it keeps only numeric series, so a run that recorded its plan always shares as a plan result, from the Guide summary, the Runs screen and `obd-read share <run file>` alike. VIN-shaped text in the notes and freeze frames is removed by default. Whoever opens it, the plan's maker included, sees the plan's title and version, the plan itself, the phases and codes, and the readings on the run graphs and their playback, with each phase's start marked on every chart, without needing the plan kept; Save this plan to my plans keeps the plan it carries, and Save these results keeps the result as a shared run with its phases and codes. A results link for a shipped plan with several signals over a few minutes stays well within the 32,000-character link limit.

```sh
obd-read plan share idle-then-rev
obd-read share --open 'https://mearman.github.io/obd/#share=2....'
obd-read plan import 'https://mearman.github.io/obd/#share=2....' --output idle.obdplan.json
obd-read share idle.json
```

`plan share` prints the link and, on standard error, the plan's version and the link's length. `share --open` prints a plan link's plan as `plan show` does and a results link's version, phases, reads, code changes, plan and run summary. `plan import` writes the plan a plan link or a results link carries to a new `.obdplan.json` file, named after the plan unless `--output` names it, and refuses one that exists.

## Sharing

A scan, a generic OBD-II read, a run summary, a raw capture, a recording plan or a plan's results can be shared as a link ([sharing plans and their results](#sharing-plans-and-their-results)). The result is packed into the fragment of the app's address, `https://mearman.github.io/obd/#share=2.<payload>`, so it is never in the part of the address a browser sends to a server: opening the link makes the same request as opening the app, and the data is read in the page.

A scan in the Session screen's Read section and each run in the Library have a Share button. Its dialog lists what the link carries, offers to remove the VIN and serial numbers or calibration identifiers (on by default), shows the link's length against the practical limit and copies the link or hands it to the system share sheet where the browser has one. A scan link carries the profile name, the time of the scan, the adapter's own name for itself, and for each control unit whether it answered, its identification values, its fault codes with their status bytes and its freeze frames. It does not carry the raw adapter transcript or the adapter's address. A generic OBD-II read (the scan of a connection with no profile) is shared as a report link: it carries the stored, pending and permanent codes of each emissions unit, its warning lamp and readiness monitors, the VIN, the freeze frame, the supported current-data values with their units, the mode 06 results and misfire counts, the time of the read and the adapter's own name for itself. It carries the codes but not their names, which a reader looks up from the codes (`share --open` names them from the bundled generic titles). A run link carries the run's details and, for each signal, the count, minimum, maximum and mean and at most 120 readings over time, not every sample. A capture link (kind `capture`) carries the capture document itself, every request and reply with its bus and addressing, how the capture was made, its notes and each session's adapter identity and program, but never the adapter's address (a capture link naming one is refused). It carries no decoded value: whoever opens it chooses the profile it is decoded with.

A page opened with `#share=` shows the result read-only, labelled as shared data with the time the link was made and clearly not from the connected adapter. It is checked against a strict schema first, and it never reaches the diagnostics service, the guard or an adapter. By default the viewer saves what the link carries to this device as soon as it has decoded and the database is ready, without closing the viewer, and says so; the Settings screen has a Save received links automatically switch, kept in this browser's `localStorage` and not in the database, and with it off nothing is written to storage unless Save is pressed. A link is saved automatically once per browser: the SHA-256 digests of the last fragments saved this way are kept in `localStorage`, so reloading or opening the same link again saves nothing more, while the same result in a newly made link is a different link. Every kind is kept with origin `shared`: a scan as a saved scan report (also marked `origin: "shared"` in its JSON), an OBD-II read as a saved report in the document `obd --output` writes, a run summary as a stopped run holding only the at most 120 readings of each signal the link carries (so its counts and means are those of the thinned series, not the sender's run), and a capture as a stored capture (refused, with a message, when a capture with the same id is stored already). Dismiss, and Save when it is used, remove the fragment from the address bar. The OBD-II report is shown with the same components as the Session screen's Read section uses for its own result.

A capture link opens in a viewer with a Decode with selector listing Generic, every shipped profile and every imported one. It starts on the profile the capture was read with when this app has it, else Generic, so the link only picks among profiles already here. Each choice decodes the capture again in the page with `decodeCapture`, the same decoding the Library's capture viewer uses: the summary counts the exchanges the profile decoded and left raw, the decoded units, values, sweep results and OBD-II report follow, the exchanges it left raw are listed, and a table of every exchange marks each one Decoded or Left raw. An imported profile is read from the database; choosing a profile writes nothing.

Removing the VIN blanks every identification value labelled as a VIN or serial number and replaces any VIN-shaped word found in other identification values (as text or as the ASCII of their bytes), notes and freeze frames. For an OBD-II report the VIN and every calibration identifier are blanked (a VIN that was not reported stays not reported) and any copy of either, or VIN-shaped word, in a note, a freeze frame or a text reading is replaced. For a capture, redaction works on the raw replies: the data bytes of every positive reply to a request that reads the VIN or a calibration identifier (mode 09 identifiers `02` and `04`) or a UDS identification value the tool labels as a VIN or serial number (`22 F190`, `22 F18C`) are overwritten with `*` (0x2A), and so is every other copy of those values, and any VIN-shaped run of ASCII, in any request or reply, keeping each message's length, so the capture still decodes and the VIN reads as asterisks; the notes, the description and error texts are scrubbed as text. It cannot find a VIN that a unit hides in bytes that are not its ASCII, nor a serial number in a manufacturer's own identifier that no rule names.

A link is limited to 32,000 characters and its data to 256 KiB as canonical JSON; a link over the limit is refused with the size and the limit rather than cut. Links over 2,000 characters are cut by some chat apps and mail clients: the Share dialog shows the link's length against that, and `share` prints the link alone on standard output and its length, with a warning past 2,000 characters, on standard error. When a result is too large, use the file instead: the saved scan JSON (`scan --output`) or the run's CSV or JSON export.

The payload is the result as canonical JSON (keys sorted, ASCII only), compressed with raw deflate (the `deflate-raw` format of the browser's `CompressionStream`, and `node:zlib` in the CLI) and written as unpadded base64url. A capture's exchanges are not written as JSON: each field of every exchange goes into a column of its own, so a discovery sweep's run of identical silent replies, the repeated bus, protocol and addressing, and the request identifiers that step by one cost almost nothing once compressed. Times are written as the gap from the exchange before, sequence numbers as the gap less one, requests and replies as bytes rather than hexadecimal, each distinct request once, and a reply without the bytes it repeats of its request (the service byte plus `0x40` and the echoed identifier of a positive reply, or the `7F` and service of a negative one). The capture's other fields are written by position with no field names. Nothing is dropped: a link decodes to exactly the capture it was made from, which the tests check field by field. What is left is mostly what only the car could say, the reply data and the timing of each exchange, so a capture of an identifier sweep and the legislated OBD-II reads of one car can fit within the length chat apps keep whole, and a longer capture grows with the replies it holds. Links of the earlier form, `#share=1.`, which compressed the whole result as JSON, still open.

```sh
obd-read share scan.json --redact-vin
obd-read obd --adapter <url> --output read.json
obd-read share read.json --redact-vin
obd-read share run.json --base https://example.com/obd/
obd-read share car.obdcap.json.gz --redact-vin
obd-read share --open 'https://mearman.github.io/obd/#share=2....'
obd-read share --open 'https://mearman.github.io/obd/#share=2....' --profile mercedes-w211
```

`obd --output <file>` reads once, prints the read (with generic code titles) and writes it as JSON; it works over CAN and K-line like `obd`. `share` takes a scan report (`scan --output`), that OBD-II read file, a run's JSON, CSV or TSV export or a capture (`.obdcap.json` or `.obdcap.json.gz`) and prints the link, under `--base` (the published app by default). `--open` prints what a link carries in the format `describe` uses, with the profile's fault-code names only for a profile this program ships; a capture link is decoded as `decode` prints it, with `--profile` (a name or a `.json` file) or else the profile the capture was read with when this program ships it, or none. `share` has no Python equivalent, so it has no recorded golden output; it is covered by its own tests. `compare` adds a line naming the side that is shared data when either scan report carries `origin: "shared"`, and prints exactly what it did before otherwise.

A link carries fault history, and anyone who has it can read it: it is only as private as the place it is pasted. There is no QR code, since a link long enough to carry a scan is more than a phone camera reads reliably from a screen.

## Reporting problems

If a screen, or one section of the Session screen, fails, the app shows what happened in plain language in its place, with Try again, Go to Connect (which opens the Session screen's Connection section) and Report this problem. The rest of the app, the other sections, the connection and any run in progress keep working, because each screen and each section is contained by an error boundary and the diagnostic service runs in its own worker. Errors a boundary cannot see (uncaught errors and unhandled promise rejections on the page, errors of the app's workers, and service calls that fail in a way the screens do not expect) show a notice with the same Report this problem button. A refused guard request, a missing profile or an adapter that does not answer is an ordinary state each screen or section explains itself, never a reported error.

Report this problem opens a dialog with the exact text that will go into a GitHub issue: a title, the error's name, message and stack, the app version and build, the browser family and major version, the operating system family, which hardware APIs the browser has, and a short log of recent app events. Issues in this repository are public, so the dialog says so. The report can be copied or downloaded, and Continue to GitHub opens the repository's new-issue form in a new tab with the title, body and the `bug` label filled in. The link is kept to a length GitHub accepts by leaving out the oldest events first and saying so in the body; if even the shortest report would not fit, the link carries a one-line note and the whole report is copied to the clipboard to paste. The app sends nothing itself: there is no analytics, beacon or request of any kind, and you submit the issue on GitHub yourself. [`.github/ISSUE_TEMPLATE/app-error.md`](.github/ISSUE_TEMPLATE/app-error.md) has the same sections for writing one by hand.

The event log is kept in memory only, is bounded in count and size, and is lost when the page closes. It records kinds and outcomes: which screen was shown, that a connection was made or ended and by which transport type (Web Serial, Web Bluetooth, WebUSB or the simulator), which service operation ran and how it ended (ok, refused by the guard, profile required, adapter error, timeout and so on), the state of storage and of the service worker, and where an error was caught. It never records data values, hexadecimal payloads, VINs, serial numbers, fault codes, adapter names or addresses, device identifiers, file names or paths, profile contents, share-link fragments or anything typed into the app; the event type has no field that could hold them.

Error text is anonymised before it is shown ([`app/src/report/anonymise.ts`](app/src/report/anonymise.ts)): VIN-shaped words (the same rule as [removing the VIN from a share link](#sharing)), long hexadecimal runs and spaced bytes, fault codes, MAC, IP and email addresses, UUIDs and long identifier-like tokens, file paths and names, URLs (only the app's own origin and path survive, never a query or fragment), quoted text, and the adapter's name and address for the current connection are replaced by a placeholder. Stack frames are cut to a function name and the app's own file and line; frames from other origins, such as an extension or a third-party script, are dropped and counted. Shape-based scrubbing cannot find a value with no recognisable shape that was not quoted, so read the report in the dialog before continuing.

## What stays unverified until the dongle and car are together

Everything above the link is tested against scripted adapters and cars, fake transports and a headless Chromium. The following has not been run against real hardware, and each item has an open issue:

- Adapter behaviours that were written from documentation: `STPBR` taking effect before the protocol opens, which bit rates each STN model accepts, whether a clone honours the `ATPB` divisor, the longest `STPX` line, eight-digit `h:` identifiers for 29-bit CAN, `STCFCPA` registration for non-legislated identifiers, the `STVR` reply format, K-line checksum and idle output, and ELM327 acknowledgement while monitoring ([issue 5](https://github.com/Mearman/obd/issues/5)). The vLinker FD+ is the intended adapter, and its real service and characteristic UUIDs are unconfirmed: Bluetooth LE adapters do not share one layout, so the tool picks the first service with both a notifying and a writable characteristic, and `?service=`, `?notify=` and `?write=` on the URL override that choice.
- Capture and decode on a real car: how long the discovery sweep takes, how units answer read-data requests for identifiers they lack, and whether any unit logs or reacts to an identifier sweep ([issue 81](https://github.com/Mearman/obd/issues/81)). Importing the K-line part of an adapter transcript is not built ([issue 80](https://github.com/Mearman/obd/issues/80)).
- The real Web Serial, Web Bluetooth and WebUSB paths, a device granted on the page and used in the worker, and the installed PWA on a phone: install prompt, standalone display, offline launch, the update toast and the unsupported-browser messages on real devices ([issue 9](https://github.com/Mearman/obd/issues/9)).
- The database worker with `opfs-sahpool` on Android Chrome, whether the installed app is granted persistent storage, and that stored runs survive the app being closed and reopened ([issue 10](https://github.com/Mearman/obd/issues/10)). The migration that adds the `origin` column has run on databases built in Node and in the end-to-end Chromium only, not on a database a phone already holds.
- The `socketcan://` addon, which has been neither built nor run against a real or virtual CAN interface ([issue 8](https://github.com/Mearman/obd/issues/8)), and gs_usb over WebUSB, checked against a fake adapter only.
- Writes, restore and actuator tests on a real car: whether a unit accepts them in the session the profile opens ([issue 7](https://github.com/Mearman/obd/issues/7)), and live value identifiers for the shipped profiles ([issue 6](https://github.com/Mearman/obd/issues/6)).
- A generic OBD-II session on a real car: it has run only against the simulator and scripted adapters, and it reads on 11-bit 500 kbit/s CAN only, so a car on another bus needs the `obd` command's `--id-bits`, `--bitrate` or `--kline` options.
- Redaction of a raw capture against real cars other than the recorded 2009 petrol hatchback: the rules were checked on the simulator's replies and the recorded transcripts only, so how other units spell the VIN or a serial number inside their own identification blocks is not known.
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

`pnpm --filter obd-read-app e2e` builds the app, serves it with `vite preview` on localhost (on port 4173, or the port in `OBD_READ_E2E_PORT` so two checkouts can run their checks at once), drives the Session screen from disconnected through connecting the simulator, a scan, a live run and the Advanced section, and in Chromium takes screenshots of every screen at phone, tablet and desktop widths in both colour schemes into `app/screenshots/` (untracked). It asserts that nothing overflows horizontally and that every interactive element is at least 44 px, reloads offline to check the shell loads from the service worker, builds and serves the app under both `/` and `/obd/` (a static server that 404s outside the prefix, as Pages does) to check the manifest, the service worker scope, a deep link and an offline reload, and drives the real database worker and OPFS (write a run, reload, reload offline, a second tab, export and import), and makes a share link from a simulator scan, and from a generic simulator scan, opens it in a fresh browser context to check the read-only viewer, that it is saved once on opening by default and that with the setting off nothing is stored until Save, makes a raw capture link from a simulator capture and opens it in a fresh context to switch the profile it is decoded with and check the same for saving, and reloads it offline and forces an error (a hook that exists only in the end-to-end build, which a test checks the production build lacks) to check the problem report dialog, that its text carries none of the simulator session's VIN, adapter name, address or payload bytes, and the new-issue link it makes. Install the browser once with `pnpm --filter obd-read-app exec playwright install chromium`, or point `OBD_READ_CHROMIUM` at a Chromium binary you already have.

The tests run against the scripted adapter and car in [`src/core/simulator.ts`](src/core/simulator.ts), the same one the `simulate` command serves.

## Deployment

The app is published as a GitHub Pages project site at <https://mearman.github.io/obd/> by [`pages.yml`](.github/workflows/pages.yml), on every push to `main`. Service workers, Web Serial, WebUSB and Web Bluetooth need a secure context, so the site is only useful over HTTPS (or `localhost`); Pages provides that. Open the URL in Chromium and use the browser's install option to add it as an app, which then reloads offline from its service worker.

The build reads one environment variable, `BASE_PATH`, in [`app/base-path.ts`](app/base-path.ts): Vite's `base`, the manifest's `id`, `scope` and `start_url`, and so the service worker's scope all follow it. It defaults to `/` for local use and previews, and the workflow sets `BASE_PATH=/obd/`. A fork publishing its own project site sets `BASE_PATH` in `pages.yml` to its repository name (`/<repository>/`), and enables Pages with the source set to GitHub Actions. The workflow skips itself in a private repository.

## Releases

Releases are made by [semantic-release](https://semantic-release.gitbook.io/) from the commit messages. When a push to `main` passes CI, the `release` job in [`ci.yml`](.github/workflows/ci.yml) reads the commits since the last tag: a `feat` releases a minor version, a `fix`, `perf` or `revert` a patch, and a breaking change (`!` or a `BREAKING CHANGE` footer) a major one. Other types release nothing. [`release.config.ts`](release.config.ts) holds that table, and [`commitlint.config.ts`](commitlint.config.ts) derives the allowed types from it, so commit-msg validation (a husky hook locally, the `Commit messages` job on pull requests) and the release rules cannot disagree. A release tags `v<version>` and creates a GitHub release with generated notes, then starts a Pages rebuild. It commits nothing back to `main`: the version lives only in the tag, the `version` fields in the two `package.json` files are placeholders, and the app build reads the latest `v<version>` tag from git (so the app builds need the full history). Nothing is published to a registry: the package is private.

The app shows its version in the top bar as a link to that release. The version is read from the latest release tag when the app is built, so it needs no network, and the link opens the release page in a new tab (which cannot load offline).

## Licence

MIT. See [LICENSE](LICENSE).
