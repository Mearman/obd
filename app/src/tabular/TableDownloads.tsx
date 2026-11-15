import { FORMAT_FILES, renderTable, type TableSpec } from "obd-read";
import { Button, download } from "../ui";

/** A delimited format a table can be downloaded in beside JSON. */
const DELIMITED = ["csv", "tsv"] as const;

/**
 * Download buttons for one table, one per delimited format: `Download <label> CSV` and `Download <label> TSV`. The file is written by the same column set the command line prints, so the two cannot disagree.
 */
export function TableDownloads<Row>({
  label,
  filename,
  spec,
  rows,
}: {
  /** What the table holds, in the buttons' names, such as `fault codes`. */
  readonly label: string;
  /** The file's name without its extension. */
  readonly filename: string;
  readonly spec: TableSpec<Row>;
  readonly rows: readonly Row[];
}) {
  return (
    <>
      {DELIMITED.map((format) => (
        <Button
          key={format}
          onClick={() => {
            const { extension, mediaType } = FORMAT_FILES[format];
            download(`${filename}.${extension}`, mediaType, renderTable(format, spec, rows));
          }}
        >
          Download {label} {format.toUpperCase()}
        </Button>
      ))}
    </>
  );
}
