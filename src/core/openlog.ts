import type { CsvLog } from "./csvlog.js";

/**
 * Opens the {@link CsvLog} a run writes its samples to, with `header` as its first row. A platform
 * supplies it, building the log on a sink that refuses to replace an earlier log.
 */
export type OpenCsvLog = (header: readonly string[]) => Promise<CsvLog>;
