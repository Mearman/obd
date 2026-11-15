/**
 * The SQLite schema of the stored runs, samples, scan reports and imported profiles.
 *
 * It is the single source of the table layout: `drizzle-kit generate` derives the SQL migrations from it, the queries in `drizzle-storage.ts` are typed from it, and the row validators come from `drizzle-orm/zod`. Times are integer milliseconds since the Unix epoch.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Collection runs. `stopped_at` is null while a run is open. */
export const runs = sqliteTable(
  "runs",
  {
    id: text().primaryKey(),
    profile: text().notNull(),
    adapter: text().notNull(),
    startedAt: integer("started_at").notNull(),
    stoppedAt: integer("stopped_at"),
    notes: text().notNull(),
  },
  (table) => [index("runs_started_at_idx").on(table.startedAt)],
);

/**
 * Samples. A value is numeric (`value_num`) or text (`value_text`), never both, so numeric aggregates use the numeric column and ordering is by `timestamp` then by the insertion `id`.
 */
export const samples = sqliteTable(
  "samples",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    signal: text().notNull(),
    unit: text().notNull(),
    timestamp: integer().notNull(),
    valueNum: real("value_num"),
    valueText: text("value_text"),
  },
  (table) => [
    index("samples_run_signal_time_idx").on(table.runId, table.signal, table.timestamp),
    index("samples_run_time_idx").on(table.runId, table.timestamp),
    check("samples_one_value", sql`(${table.valueNum} is null) <> (${table.valueText} is null)`),
  ],
);

/** Saved scan reports; `report` is the JSON text. */
export const scanReports = sqliteTable(
  "scan_reports",
  {
    id: text().primaryKey(),
    profile: text().notNull(),
    adapter: text().notNull(),
    takenAt: integer("taken_at").notNull(),
    label: text().notNull(),
    report: text().notNull(),
  },
  (table) => [index("scan_reports_taken_at_idx").on(table.takenAt)],
);

/** Imported profiles, keyed by the profile's own name; `document` is the JSON text. */
export const profiles = sqliteTable("profiles", {
  name: text().primaryKey(),
  importedAt: integer("imported_at").notNull(),
  document: text().notNull(),
});
