# obd-read (TypeScript)

The TypeScript implementation of obd-read, which runs in Node and in the browser. It is developed here during the migration from the Python tool and is later promoted to the repository root.

## Layout

- `src/core/` is platform-free: no `node:` imports and no DOM-only globals. It holds the `Transport` contract, adapter URL parsing, the transport registry and, as the layers are ported, the protocol, profile and storage logic. Two checks keep it that way: an ESLint `no-restricted-imports` and `no-restricted-globals` rule on `src/core/`, and `tsconfig.core.json`, which typechecks `src/core/` with neither the Node nor the DOM type libraries, so a use of either fails `pnpm typecheck`.
- `src/core/testing/` holds a scripted in-process transport for tests, used by this package and by platform packages.
- `test/` holds the vitest suites.

## Core and platform

Core never imports a platform module. Each platform entry point supplies the transports it can build and registers them with `registerTransport`; `openTransport(url)` then builds the transport an adapter URL names, and fails with a `TransportError` when no entry point serves the scheme.

| Entry point               | Schemes                                      |
| ------------------------- | -------------------------------------------- |
| `obd-read/node` (planned) | `ble`, `serial`, `tcp`, `socketcan`, `slcan` |
| `obd-read/web` (planned)  | `webserial`, `webbluetooth`, `webusb`        |

In a browser the user picks the device in a prompt opened by a gesture, so the target of a `web*` URL (`webserial://vLinker`) is only a free label for the adapter and selects nothing. Raw TCP is not available in a browser.

## Commands

Run from this directory with pnpm: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. CI runs the same commands.
