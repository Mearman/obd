/**
 * Delimiter-separated text: the one writer and reader every CSV and TSV file this package produces or accepts goes through. This module is platform-free.
 *
 * Both dialects are UTF-8 text with a header row, and every value is a string; a value that is a number or a time is formatted by the caller. Nothing is escaped for spreadsheets: a value that starts with `=`, `+`, `-` or `@` is written as it is.
 *
 * - `csv` is RFC 4180: fields are separated by commas, a field holding a comma, a double quote, a carriage return or a line feed is wrapped in double quotes with each quote doubled, and every record ends with CRLF. A record of one empty field is written as `""` so it is not a blank line.
 * - `tsv` separates fields with a tab and ends every record with LF. A field is never quoted; instead the characters that would break the layout are escaped: a tab as `\t`, a line feed as `\n`, a carriage return as `\r` and a backslash as `\\`. Every other character is written as it is, and a backslash followed by anything else is an error when reading.
 */

/** The delimited dialects: `csv` (RFC 4180) and `tsv` (tab-separated with backslash escapes). */
export const DIALECTS = ["csv", "tsv"] as const;

/** A delimited dialect. */
export type Dialect = (typeof DIALECTS)[number];

/** The formats a table can be written in: the delimited dialects and JSON. */
export const TABLE_FORMATS = ["csv", "tsv", "json"] as const;

/** A format a table can be written in. */
export type TableFormat = (typeof TABLE_FORMATS)[number];

/** The file extension, without a dot, and media type of each format. */
export const FORMAT_FILES: Readonly<
  Record<TableFormat, { readonly extension: string; readonly mediaType: string }>
> = {
  csv: { extension: "csv", mediaType: "text/csv" },
  tsv: { extension: "tsv", mediaType: "text/tab-separated-values" },
  json: { extension: "json", mediaType: "application/json" },
};

/** The text that ends a record in each dialect. */
const TERMINATORS: Readonly<Record<Dialect, string>> = { csv: "\r\n", tsv: "\n" };

/** Delimited text that cannot be read: an unterminated quote, text after a closing quote or an unknown escape. */
export class TabularError extends Error {
  override name = "TabularError";
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const TSV_ESCAPES: Readonly<Record<string, string>> = {
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
  "\\": "\\\\",
};

function tsvField(value: string): string {
  return value.replace(/[\t\n\r\\]/g, (character) => TSV_ESCAPES[character] ?? character);
}

/** One record in `dialect`, with its terminator. */
export function formatRow(dialect: Dialect, row: readonly string[]): string {
  const terminator = TERMINATORS[dialect];
  if (dialect === "csv") {
    if (row.length === 1 && row[0] === "") return `""${terminator}`;
    return row.map(csvField).join(",") + terminator;
  }
  return row.map(tsvField).join("\t") + terminator;
}

/** A table as text in `dialect`: the header record, then one record per row. */
export function formatTable(
  dialect: Dialect,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [header, ...rows].map((row) => formatRow(dialect, row)).join("");
}

function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  let started = false;
  const endField = (): void => {
    record.push(field);
    field = "";
    quoted = false;
    closed = false;
  };
  const endRecord = (): void => {
    if (started) {
      endField();
      records.push(record);
    }
    record = [];
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        closed = true;
      }
      continue;
    }
    if (character === ",") {
      started = true;
      endField();
    } else if (character === "\n" || (character === "\r" && text.charAt(index + 1) === "\n")) {
      if (character === "\r") index += 1;
      endRecord();
    } else if (closed) {
      throw new TabularError(`text after a closing quote in record ${String(records.length + 1)}`);
    } else if (character === '"' && field === "") {
      started = true;
      quoted = true;
    } else {
      started = true;
      field += character;
    }
  }
  if (quoted) throw new TabularError(`unterminated quote in record ${String(records.length + 1)}`);
  endRecord();
  return records;
}

const TSV_UNESCAPES: Readonly<Record<string, string>> = { t: "\t", n: "\n", r: "\r", "\\": "\\" };

function unescapeTsv(field: string, record: number): string {
  if (!field.includes("\\")) return field;
  let value = "";
  for (let index = 0; index < field.length; index += 1) {
    const character = field.charAt(index);
    if (character !== "\\") {
      value += character;
      continue;
    }
    const next = field.charAt(index + 1);
    const decoded = TSV_UNESCAPES[next];
    if (decoded === undefined) {
      throw new TabularError(
        `unknown escape \\${next} in record ${String(record)}; a TSV field escapes tab, line feed, carriage return and backslash as \\t, \\n, \\r and \\\\`,
      );
    }
    value += decoded;
    index += 1;
  }
  return value;
}

function parseTsv(text: string): string[][] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) =>
    (line.endsWith("\r") ? line.slice(0, -1) : line)
      .split("\t")
      .map((field) => unescapeTsv(field, index + 1)),
  );
}

/**
 * Reads delimited text into records of fields, the inverse of {@link formatTable}: every value written comes back unchanged.
 *
 * A leading byte order mark is ignored. Either CRLF or LF ends a CSV record, and a blank CSV line is skipped, since the writer never produces one. A final record need not end with a terminator.
 *
 * @throws TabularError for an unterminated quote, text after a closing quote or an unknown TSV escape.
 */
export function parseTable(dialect: Dialect, text: string): string[][] {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  return dialect === "csv" ? parseCsv(body) : parseTsv(body);
}

/** One column of a table: its header and how a row gives its cell. */
export interface TableColumn<Row> {
  readonly header: string;
  readonly cell: (row: Row) => string;
}

/** A set of columns defined once, so every place that writes the table agrees on its header and cells. */
export interface TableSpec<Row> {
  readonly columns: readonly TableColumn<Row>[];
}

/** A table's header titles. */
export function tableHeader<Row>(spec: TableSpec<Row>): string[] {
  return spec.columns.map((column) => column.header);
}

/** A table's rows as arrays of cells. */
export function tableCells<Row>(spec: TableSpec<Row>, rows: readonly Row[]): string[][] {
  return rows.map((row) => spec.columns.map((column) => column.cell(row)));
}

/**
 * A table as the text of `format`: CSV or TSV through {@link formatTable}, or JSON as an array with one object per row, keyed by header and indented by two spaces, ending in a line feed.
 */
export function renderTable<Row>(
  format: TableFormat,
  spec: TableSpec<Row>,
  rows: readonly Row[],
): string {
  if (format === "json") {
    const objects = rows.map((row) =>
      Object.fromEntries(spec.columns.map((column) => [column.header, column.cell(row)] as const)),
    );
    return `${JSON.stringify(objects, null, 2)}\n`;
  }
  return formatTable(format, tableHeader(spec), tableCells(spec, rows));
}
