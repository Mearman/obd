import { defineConfig } from "drizzle-kit";

/** `pnpm storage:generate` writes the SQL migrations for `src/storage/schema.ts` into `src/storage/migrations/`. */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/schema.ts",
  out: "./src/storage/migrations",
});
