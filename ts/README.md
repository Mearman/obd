# obd-read (TypeScript)

The TypeScript implementation of obd-read, which runs in Node and in the browser. It is developed here during the migration from the Python tool and is later promoted to the repository root.

## Layout

- `src/core/` is platform-free: no `node:` imports and no DOM-only globals. It holds the `Transport` contract, adapter URL parsing, the transport registry and, as the layers are ported, the protocol, profile and storage logic. Two checks keep it that way: an ESLint `no-restricted-imports` and `no-restricted-globals` rule on `src/core/`, and `tsconfig.core.json`, which typechecks `src/core/` with neither the Node nor the DOM type libraries, so a use of either fails `pnpm typecheck`.
- `src/core/testing/` holds a scripted in-process transport for tests, used by this package and by platform packages.
- `src/profiles/` and `src/data/` hold the bundled vehicle profiles (JSON, validated by the Zod schema in `src/core/profile.ts`) and the generic fault-code titles, each exposed through a registry module that imports the JSON, so they load in Node and in the browser. Core takes parsed JSON or file bytes and never reads a file.
- `src/node/` holds the Node-only transports (`serialport`, `node:net`, `@stoprocent/noble`) and adapter discovery, behind the `obd-read/node` entry point. Importing it registers the transports. The Bluetooth LE radio sits behind the `BleCentral` interface, so the data-channel picker and the transport are tested against a fake peripheral and only `src/node/noble.ts` touches the native binding. The native packages ship prebuilt binaries, so their install scripts are denied in `pnpm-workspace.yaml`.
- `test/` holds the vitest suites.

## Core and platform

Core never imports a platform module. Each platform entry point supplies the transports it can build and registers them with `registerTransport`; `openTransport(url)` then builds the transport an adapter URL names, and fails with a `TransportError` when no entry point serves the scheme.

| Entry point     | Schemes                                                     |
| --------------- | ----------------------------------------------------------- |
| `obd-read/node` | `ble`, `serial`, `tcp`; `socketcan` and `slcan` are planned |
| `obd-read/web`  | `webserial`, `webbluetooth` (`webusb` planned)              |

In a browser the user picks the device in a prompt opened by a gesture. The target of a `webserial` or `webusb` URL is only a free label that selects nothing; the target of a `webbluetooth` URL is also the device name prefix the picker is limited to (`all=1` lists every device). Raw TCP is not available in a browser.

## Commands

Run from this directory with pnpm: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. CI runs the same commands.
