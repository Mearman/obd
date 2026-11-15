/**
 * A CSV log written one row at a time, so a run that is interrupted keeps what it logged.
 *
 * This module is platform-free: it formats rows and hands them to a {@link CsvSink}, which each platform supplies (a file in Node, a stored run in the browser).
 */

import { formatRow, type Dialect } from "./tabular.js";

/**
 * Where a log's text goes. Each `write` resolves only once the text is durable enough to survive an interrupted run (flushed to disk, committed to storage).
 *
 * A sink that creates a file must refuse to overwrite an existing one: an earlier log is evidence and is never replaced.
 */
export interface CsvSink {
  /** Appends the text. */
  write(text: string): Promise<void>;

  /** Releases the destination. */
  close(): Promise<void>;
}

/**
 * One CSV record in the Excel dialect, ended by CRLF; see {@link formatRow} for the quoting rule.
 */
export function csvRow(row: readonly string[]): string {
  return formatRow("csv", row);
}

/** A new log of delimited rows, CSV unless a dialect says TSV, with a header row. Each row is written to the sink as it is given. */
export class CsvLog {
  private constructor(
    private readonly sink: CsvSink,
    private readonly dialect: Dialect,
  ) {}

  /** Opens a log on the sink and writes the header row in `dialect`. */
  static async create(
    sink: CsvSink,
    header: readonly string[],
    dialect: Dialect = "csv",
  ): Promise<CsvLog> {
    const log = new CsvLog(sink, dialect);
    await log.write(header);
    return log;
  }

  /** Appends one row and waits for the sink to accept it. */
  async write(row: readonly string[]): Promise<void> {
    await this.sink.write(formatRow(this.dialect, row));
  }

  /** Closes the sink. */
  async close(): Promise<void> {
    await this.sink.close();
  }
}
