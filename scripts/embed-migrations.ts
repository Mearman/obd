import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles, renderMigrationsModule } from "./migration-files.ts";

const storage = fileURLToPath(new URL("../src/storage/", import.meta.url));

writeFileSync(
  `${storage}migrations.ts`,
  renderMigrationsModule(readMigrationFiles(`${storage}migrations`)),
);
