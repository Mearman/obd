import { FORMAT_FILES, renderTable, type TableSpec } from "obd-read";
import { Menu, download, type MenuItem } from "../ui";

/** A delimited format a table can be downloaded in beside JSON. */
const DELIMITED = ["csv", "tsv"] as const;

/** One table that can be downloaded, with the items that save it in each delimited format. */
export interface TableDownload {
  readonly items: readonly MenuItem[];
}

/**
 * One table's download items, one per delimited format, labelled `<label> CSV` and `<label> TSV`. The file is written by the same column set the command line prints, so the two cannot disagree.
 *
 * @param label What the table holds, in the items' names, such as `fault codes`.
 * @param filename The file's name without its extension.
 */
export function tableDownload<Row>(
  label: string,
  filename: string,
  spec: TableSpec<Row>,
  rows: readonly Row[],
): TableDownload {
  return {
    items: DELIMITED.map((format) => ({
      label: `${label} ${format.toUpperCase()}`,
      onSelect: () => {
        const { extension, mediaType } = FORMAT_FILES[format];
        download(`${filename}.${extension}`, mediaType, renderTable(format, spec, rows));
      },
    })),
  };
}

/** One Download menu holding every table's CSV and TSV items, so several tables take the room of one button. */
export function DownloadMenu({ tables }: { readonly tables: readonly TableDownload[] }) {
  return <Menu label="Download" items={tables.flatMap((table) => table.items)} />;
}
