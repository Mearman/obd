/**
 * A CSV log written one row at a time, so a run that is interrupted keeps what it logged.
 *
 * This module is platform-free: it formats rows and hands them to a {@link CsvSink}, which each platform supplies (a file in Node, a stored run in the browser).
 */

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

const TERMINATOR = "\r\n";

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * One CSV record in the Excel dialect: fields separated by commas, a field holding a comma, a double quote or a line break wrapped in double quotes with quotes doubled, and a record ended by CRLF. A record of one empty field is written as `""` so it is not a blank line.
 */
export function csvRow(row: readonly string[]): string {
  if (row.length === 1 && row[0] === "") return `""${TERMINATOR}`;
  return row.map(field).join(",") + TERMINATOR;
}

/** A new CSV log with a header row. Each row is written to the sink as it is given. */
export class CsvLog {
  private constructor(private readonly sink: CsvSink) {}

  /** Opens a log on the sink and writes the header row. */
  static async create(sink: CsvSink, header: readonly string[]): Promise<CsvLog> {
    const log = new CsvLog(sink);
    await log.write(header);
    return log;
  }

  /** Appends one row and waits for the sink to accept it. */
  async write(row: readonly string[]): Promise<void> {
    await this.sink.write(csvRow(row));
  }

  /** Closes the sink. */
  async close(): Promise<void> {
    await this.sink.close();
  }
}
