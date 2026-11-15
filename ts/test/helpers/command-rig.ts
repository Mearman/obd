/**
 * Runs one command the way the command line does: open the adapter, initialise it, print the
 * adapter lines, run the command, report a command error as `error: ...` and close the link.
 */

import {
  Elm,
  printAdapter,
  profileCommand,
  reportCommandError,
  type Profile,
  type ProfileCommand,
  type OutputFiles,
  type Transport,
} from "../../src/core/index.js";
import { WritableMemoryStore } from "./unit-rig.js";

/** Report files held in memory, replaced on each write. */
export class MemoryFiles implements OutputFiles {
  readonly files = new Map<string, string>();

  write(name: string, text: string): Promise<void> {
    this.files.set(name, text);
    return Promise.resolve();
  }

  /** The text of a file written earlier. */
  text(name: string): string {
    const text = this.files.get(name);
    if (text === undefined) throw new Error(`no file named ${name}`);
    return text;
  }
}

/** What one command printed and returned. */
export interface CommandRun {
  readonly status: number;
  readonly lines: string[];
}

/** What {@link runProfileCommand} needs. */
export interface ProfileRun {
  /** The adapter link; it is opened and closed around the command. */
  readonly transport: Transport;
  /** Builds the session over the link. Default: a plain session. */
  readonly makeElm?: (transport: Transport) => Elm;
  readonly profile: Profile;
  readonly command: ProfileCommand;
  /** What the user types at a prompt. Default: nothing. */
  readonly answer?: string;
  readonly store?: WritableMemoryStore;
  readonly files?: MemoryFiles;
}

/** Runs a profile command and returns its exit status and every line it printed. */
export async function runProfileCommand(run: ProfileRun): Promise<CommandRun> {
  const lines: string[] = [];
  const out = (line: string): void => {
    lines.push(line);
  };
  await run.transport.open();
  try {
    const elm = run.makeElm?.(run.transport) ?? new Elm(run.transport);
    const adapter = await elm.initialise();
    printAdapter(adapter, out);
    const status = await profileCommand(run.command, {
      elm,
      adapter,
      profile: run.profile,
      store: run.store ?? new WritableMemoryStore(),
      files: run.files ?? new MemoryFiles(),
      out,
      ask: () => Promise.resolve(run.answer ?? ""),
    });
    return { status, lines };
  } catch (error) {
    return { status: reportCommandError(error, out), lines };
  } finally {
    await run.transport.close();
  }
}
