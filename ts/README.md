# obd-read (TypeScript)

The TypeScript implementation of obd-read, which runs in Node and in the browser. It is developed here during the migration from the Python tool and is later promoted to the repository root.

## Layout

- `src/core/` is platform-free: no `node:` imports and no DOM-only globals. It holds the `Transport` contract, adapter URL parsing, the transport registry and, as the layers are ported, the protocol, profile and storage logic. Two checks keep it that way: an ESLint `no-restricted-imports` and `no-restricted-globals` rule on `src/core/`, and `tsconfig.core.json`, which typechecks `src/core/` with neither the Node nor the DOM type libraries, so a use of either fails `pnpm typecheck`.
- `src/core/testing/` holds a scripted in-process transport for tests, used by this package and by platform packages.
- `src/profiles/` and `src/data/` hold the bundled vehicle profiles (JSON, validated by the Zod schema in `src/core/profile.ts`) and the generic fault-code titles, each exposed through a registry module that imports the JSON, so they load in Node and in the browser. Core takes parsed JSON or file bytes and never reads a file.
- `src/node/` holds the Node-only transports (`serialport`, `node:net`, `@stoprocent/noble`) and adapter discovery, behind the `obd-read/node` entry point. Importing it registers the transports. The Bluetooth LE radio sits behind the `BleCentral` interface, so the data-channel picker and the transport are tested against a fake peripheral and only `src/node/noble.ts` touches the native binding. The native packages ship prebuilt binaries, so their install scripts are denied in `pnpm-workspace.yaml`.
- `src/storage/` holds the SQLite implementation of the core `Storage` contract: the Drizzle schema (`schema.ts`), the SQL migrations `drizzle-kit` generates from it (`migrations/`, embedded into `migrations.ts` so a browser build needs no file access) and `DrizzleStorage`, which runs only through an injected `SqlExecutor`. `obd-read/node` supplies an executor over `node:sqlite` (`openNodeStorage`); `obd-read/web` supplies one that posts SQL to a worker that owns the database (`openWorkerStorage`). Drizzle stays behind `Storage`.
- `src/service/` holds the oRPC message-port wiring for the `DiagnosticsService` contract in `src/core/service.ts` (`serveDiagnostics`, `connectDiagnostics`). The contract and its in-process implementation over `Storage` are in core; operations that need the OBD and live modules are declared in `pendingDiagnosticsContract` and served by nothing yet.
- `app/` is the browser app, a separate private workspace package (`obd-read-app`) that depends on this package through the workspace. See [The app](#the-app).
- `test/` holds the vitest suites. The storage contract suite (`test/support/storage-contract.ts`) runs against the in-memory storage, Drizzle over `node:sqlite` and Drizzle through the message-port worker; the service contract suite runs in process and over a message port.

## Core and platform

Core never imports a platform module. Each platform entry point supplies the transports it can build and registers them with `registerTransport`; `openTransport(url)` then builds the transport an adapter URL names, and fails with a `TransportError` when no entry point serves the scheme.

| Entry point     | Schemes                                                   |
| --------------- | --------------------------------------------------------- |
| `obd-read/node` | `ble`, `serial`, `tcp`, `slcan`, `socketcan` (Linux only) |
| `obd-read/web`  | `webserial`, `webbluetooth`, `webusb`                     |

In a browser the user picks the device in a prompt opened by a gesture. The target of a `webserial` or `webusb` URL is only a free label that selects nothing; the target of a `webbluetooth` URL is also the device name prefix the picker is limited to (`all=1` lists every device). Raw TCP is not available in a browser.

## Storage migrations

After changing `src/storage/schema.ts` run `pnpm storage:generate`: it writes the new SQL migration with `drizzle-kit` and regenerates `src/storage/migrations.ts`. A test fails when the embedded module and the migration folder disagree.

## CAN adapters

A raw CAN link is presented to the session as an ELM327 adapter (`RawCanTransport`), so the same session code drives it. `slcan://<serial device>?baud=N` is an SLCAN adapter on a serial port. `socketcan://<interface>` is a Linux SocketCAN interface (`can0`, `vcan0`, or a candleLight adapter running gs_usb firmware) reached through the optional `socketcan` package, a native addon that is Linux-only and is not built during `pnpm install` because install scripts are denied: on Linux run `pnpm rebuild socketcan` once (it needs a C++ toolchain), and set the interface's bit rate outside the program (`ip link set can0 type can bitrate 500000`). `webusb://<label>` drives a candleLight, CANable or other gs_usb adapter directly from a browser over WebUSB, which is also the route on macOS and Windows, where there is no SocketCAN; the picker is limited to the gs_usb vendor and product ids unless `usbVendorId` and `usbProductId` are given, and `channel` selects a channel on a multi-channel adapter. The gs_usb protocol and bit-timing calculation are in `src/core/gsusb.ts` and are checked against a fake adapter, not against hardware.

## The app

`app/` is an installable, offline-capable PWA built with Vite and React. Styling is vanilla-extract (a CSS-variable theme contract for light and dark, recipes and sprinkles) over Radix UI primitives, so there is no runtime style engine. The layout is mobile-first with phone, tablet and desktop breakpoints, 44 px touch targets and safe-area insets, and the connect flow is built for one-handed use. Data tables reflow to cards on narrow screens.

The screens (Connect, Scan, Live values, Runs, Settings) talk to a small `DiagnosticsClient` interface (`app/src/diagnostics/client.ts`). Only a simulator implements it so far: it returns fixed invented values, every screen labels them "Simulated data", and it refuses real adapters. The real diagnostic service replaces it without UI changes. The Connect screen uses `capabilities()` from `obd-read/web` to explain why Web Serial or Web Bluetooth is unavailable (Safari, Firefox, iOS, or a page that is not a secure context). Settings imports a profile from a local JSON file, validated by the same Zod schema as the bundled profiles; imported profiles last until the page closes.

`vite-plugin-pwa` precaches the whole shell and the bundled profiles and generates the manifest and icons from `app/public/icon.svg` at build time. The app makes no runtime network requests (an ESLint rule forbids `fetch`, `XMLHttpRequest` and `WebSocket` in `app/src/`), loads no CDN scripts and no web fonts. A new service worker waits until the user chooses Reload in the update toast.

Build the package first, because the app imports it through its built exports, then work in the app:

```sh
pnpm install
pnpm build
pnpm --filter obd-read-app lint
pnpm --filter obd-read-app typecheck
pnpm --filter obd-read-app test
pnpm --filter obd-read-app build
pnpm --filter obd-read-app dev
```

`pnpm --filter obd-read-app e2e` builds the app, serves it with `vite preview` on localhost, and in Chromium takes screenshots of every screen at phone (390x844), tablet (820x1180) and desktop (1440x900) in both colour schemes into `app/screenshots/` (untracked). It asserts that nothing overflows horizontally and that every interactive element is at least 44 px, and it reloads offline to check the shell loads from the service worker. Install the browser once with `pnpm --filter obd-read-app exec playwright install chromium`, or point `OBD_READ_CHROMIUM` at a Chromium or headless-shell binary you already have. CI runs the same script in its own job.

Not covered by any of this: the real Web Serial and Web Bluetooth APIs, real adapters, and how the installed app behaves on a phone.

## Command line

`obd-read` (`src/node/bin.ts`, built to `dist/node/bin.js`) has every command and option of the Python tool, with the same argument names, defaults, output and exit statuses: 0 on success, 1 for a command that failed or reported an `error:`, 2 for arguments the parser rejects, 130 after an interrupt. `src/node/cli-args.ts` is the argument parser (not `node:util` `parseArgs`, which rejects a value that starts with a dash and has no sub-commands, required options or choices); `cli-commands.ts` declares the commands; `cli.ts` calls the core functions and prints what they return; `cli-files.ts` holds the platform sinks. A snapshot, a CSV log, a monitor log and a draft profile are created exclusively and never replaced. The broker credentials come only from `OBD_READ_MQTT_USER` and `OBD_READ_MQTT_PASSWORD`. A write, restore or actuation always asks for a typed `yes` and has no flag that skips it, and `clear` and `clear-codes` skip it only with `--yes`, as the Python tool did. Profiles are JSON (`--profile mercedes-w211` or a path ending in `.json`).

### Parity with the Python command line

Until the Python is deleted, `test/parity/` holds the TypeScript command line to what the Python one prints. `test/golden/scenarios.json` lists the command lines, scripted cars and files; `scripts/record_golden.py` (run with `uv run --python 3.13 python -I scripts/record_golden.py` from the repository root) runs each against the Python tool and writes `test/golden/<scenario>.golden.json` with the exact standard output, standard error, exit status, written files and broker traffic. The goldens are only ever regenerated by that script, and `--check` (run in CI) fails when they are stale relative to the Python sources. `pnpm test:parity` runs the same scenarios through `run` on the scripted adapters and compares. The only differences allowed are listed in `test/parity/normalise.ts`.

## Commands

Run from this directory with pnpm: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. CI runs the same commands.
