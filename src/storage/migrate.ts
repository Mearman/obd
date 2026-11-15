import type { SqlExecutor } from "./executor.js";
import { MIGRATIONS, type Migration } from "./migrations.js";

const TABLE = "obd_migrations";

/**
 * Applies the migrations a database has not yet had, each in its own transaction, and records them in the `obd_migrations` table.
 *
 * Drizzle's own migrator reads migration folders from the file system, which a browser build has none of, so the migrations are embedded in `migrations.ts` and applied here. Foreign keys are enabled first because SQLite scopes that setting to the connection.
 *
 * @param migrations Defaults to every migration `schema.ts` has produced; tests pass fewer to exercise an upgrade.
 */
export async function applyMigrations(
  execute: SqlExecutor,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  await execute("PRAGMA foreign_keys = ON", [], "run");
  await execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (tag text PRIMARY KEY NOT NULL)`, [], "run");
  const applied = new Set(
    (await execute(`SELECT tag FROM ${TABLE}`, [], "all")).map(([tag]) => tag),
  );
  for (const migration of migrations) {
    if (applied.has(migration.tag)) continue;
    await execute("BEGIN", [], "run");
    try {
      for (const statement of migration.statements) await execute(statement, [], "run");
      await execute(`INSERT INTO ${TABLE} (tag) VALUES (?)`, [migration.tag], "run");
      await execute("COMMIT", [], "run");
    } catch (error) {
      await execute("ROLLBACK", [], "run");
      throw error;
    }
  }
}
