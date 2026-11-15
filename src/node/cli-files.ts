/**
 * The files the command line reads and writes: the platform sinks core asks for.
 *
 * Every file that is evidence (a snapshot, a CSV log, a monitor log, a draft profile) is created exclusively and never replaced. A scan report and the adapter transcript are the exceptions the Python tool made too: a report is replaced by a later scan of the same name, and the transcript is appended to.
 */

import { appendFileSync } from "node:fs";
import { access, open, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CsvLog, type CsvSink } from "../core/csvlog.js";
import type { LogSink } from "../core/monitor.js";
import type { OpenCsvLog } from "../core/openlog.js";
import { pythonRepr } from "../core/format.js";
import { OptionError } from "../core/options.js";
import type { OutputFiles } from "../core/operations.js";
import type { WritableSnapshotStore } from "../core/writes.js";

/** What Python's `OSError` says for the file errors a command line meets, so the text matches. */
export function fileErrorText(error: unknown, path: string): string {
  if (error instanceof Error && "code" in error) {
    const reasons: Readonly<Record<string, string>> = {
      ENOENT: "[Errno 2] No such file or directory",
      EACCES: "[Errno 13] Permission denied",
      EISDIR: "[Errno 21] Is a directory",
      ENOTDIR: "[Errno 20] Not a directory",
    };
    const reason = typeof error.code === "string" ? reasons[error.code] : undefined;
    if (reason !== undefined) return `${reason}: ${pythonRepr(path)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether `error` is the file system reporting that the file already exists. */
function alreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * Creates a file that must not exist and returns a handle to append to it.
 *
 * @param refusal The message of the {@link OptionError} thrown when the file exists.
 */
async function createExclusive(path: string, refusal: string): ReturnType<typeof open> {
  try {
    return await open(path, "wx");
  } catch (error) {
    if (alreadyExists(error)) throw new OptionError(refusal);
    throw error;
  }
}

/**
 * Writes `bytes` to a new file `path` under `directory`, refusing to replace one that exists.
 *
 * @throws OptionError naming the file when it exists.
 */
export async function writeNewFile(
  directory: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await createExclusive(
    resolve(directory, path),
    `${path} already exists; choose a new file`,
  );
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Snapshots and drafts as files under `directory`, named as the user gave them (a relative name stays relative in every message). A snapshot is created exclusively, so an earlier one is never replaced.
 */
export class FileSnapshotStore implements WritableSnapshotStore {
  constructor(private readonly directory: string) {}

  async exists(snapshot: string): Promise<boolean> {
    return exists(resolve(this.directory, snapshot));
  }

  async size(snapshot: string): Promise<number> {
    return (await stat(resolve(this.directory, snapshot))).size;
  }

  async readText(snapshot: string): Promise<string> {
    try {
      return await readFile(resolve(this.directory, snapshot), "utf8");
    } catch (error) {
      throw new Error(fileErrorText(error, snapshot), { cause: error });
    }
  }

  async create(snapshot: string, text: string): Promise<void> {
    const handle = await open(resolve(this.directory, snapshot), "wx");
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
  }
}

/** Scan reports as files under `directory`; a report replaces an earlier one of the same name. */
export class FileOutputFiles implements OutputFiles {
  constructor(private readonly directory: string) {}

  async write(name: string, text: string): Promise<void> {
    await writeFile(resolve(this.directory, name), text, "utf8");
  }
}

/** A CSV sink that creates `path` exclusively and writes each row as it is given. */
async function csvFileSink(directory: string, path: string): Promise<CsvSink> {
  const handle = await createExclusive(
    resolve(directory, path),
    `${path} already exists; choose a new file for the log`,
  );
  return {
    write: async (text) => {
      await handle.write(text);
    },
    close: () => handle.close(),
  };
}

/** Opens CSV logs as new files named `path` under `directory`, refusing to replace one. */
export function csvLogOpener(directory: string, path: string): OpenCsvLog {
  return async (header) => CsvLog.create(await csvFileSink(directory, path), header);
}

/** The destination of a monitor log: a new file that is never replaced. */
export function monitorLogFile(
  directory: string,
  path: string,
): { readonly label: string; open(): Promise<LogSink> } {
  return {
    label: path,
    open: async () => {
      if (await exists(resolve(directory, path))) {
        throw new OptionError(`${path} already exists; the monitor will not overwrite a log`);
      }
      const handle = await createExclusive(
        resolve(directory, path),
        `${path} already exists; the monitor will not overwrite a log`,
      );
      return {
        write: async (line) => {
          await handle.write(line);
        },
        close: () => handle.close(),
      };
    },
  };
}

/** A transcript sink that appends each entry as a line of the file `path` under `directory`. */
export function transcriptAppender(directory: string, path: string): (entry: string) => void {
  const target = resolve(directory, path);
  return (entry) => {
    appendFileSync(target, `${entry}\n`, "utf8");
  };
}

/**
 * Reads lines from `input` one at a time, for the confirmations. The prompt goes to `output` without a line break, as Python's `input` does. At the end of the input every later answer is empty, which declines the confirmation (Python raises `EOFError` there and exits with a traceback).
 */
export function lineAsker(
  input: Readable,
  output: Writable,
): { readonly ask: (prompt: string) => Promise<string>; readonly close: () => void } {
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  return {
    ask: async (prompt) => {
      output.write(prompt);
      const next = await lines.next();
      return next.done === true ? "" : next.value;
    },
    close: () => {
      reader.close();
    },
  };
}
