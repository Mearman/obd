/** A CSV log kept in memory, for tests of the commands that write one. */

import { CsvLog, type CsvSink, type OpenCsvLog } from "../../src/core/index.js";

/** The log a command opens, and the rows it wrote, read back from the CSV text. */
export class MemoryCsv implements CsvSink {
  private text = "";
  closed = false;

  /** Opens the log with the header row, as a platform would on a new destination. */
  readonly open: OpenCsvLog = (header) => CsvLog.create(this, header);

  write(text: string): Promise<void> {
    this.text += text;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** The header and every row, split into fields. The tests' values never need quoting. */
  get rows(): string[][] {
    return this.text
      .split("\r\n")
      .filter((line) => line !== "")
      .map((line) => line.split(","));
  }
}
