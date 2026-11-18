import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeSqliteExecutor, openNodeStorage } from "../src/node/index.js";
import { MIGRATIONS, applyMigrations } from "../src/storage/index.js";
import { readMigrationFiles, renderMigrationsModule } from "../scripts/migration-files.js";
import { readFileSync } from "node:fs";
import { reportVin, type Json } from "../src/core/index.js";

describe("the embedded migrations", () => {
  it("match the SQL drizzle-kit generated, so regenerating changes nothing", () => {
    const directory = new URL("../src/storage/", import.meta.url);
    expect(readFileSync(new URL("migrations.ts", directory), "utf8")).toBe(
      renderMigrationsModule(readMigrationFiles(new URL("migrations", directory).pathname)),
    );
    expect(MIGRATIONS.length).toBeGreaterThan(0);
  });
});

describe("applyMigrations", () => {
  it("applies each migration once, however often it runs", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    await applyMigrations(execute);
    await applyMigrations(execute);
    const applied = await execute("SELECT tag FROM obd_migrations ORDER BY tag", [], "all");
    expect(applied).toEqual(MIGRATIONS.map((migration) => [migration.tag]));
    database.close();
  });

  it("applies only the migrations a database lacks", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    await applyMigrations(execute, [{ tag: "001", statements: ["CREATE TABLE a (x integer)"] }]);
    await applyMigrations(execute, [
      { tag: "001", statements: ["CREATE TABLE a (x integer)"] },
      { tag: "002", statements: ["CREATE TABLE b (y integer)"] },
    ]);
    const tables = await execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'b') ORDER BY name",
      [],
      "all",
    );
    expect(tables).toEqual([["a"], ["b"]]);
    database.close();
  });

  it("rolls a failed migration back whole and leaves it unrecorded", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    await expect(
      applyMigrations(execute, [
        { tag: "001", statements: ["CREATE TABLE a (x integer)", "CREATE TABLE a (x integer)"] },
      ]),
    ).rejects.toThrow(/already exists/);
    expect(await execute("SELECT name FROM sqlite_master WHERE name = 'a'", [], "all")).toEqual([]);
    expect(await execute("SELECT tag FROM obd_migrations", [], "all")).toEqual([]);
    database.close();
  });
});

describe("the origin migration", () => {
  it("marks a capture imported from a file and a scan saved from a share link, and every other record local", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    const origin = MIGRATIONS.findIndex((migration) =>
      migration.statements.some((statement) => statement.includes("ADD `origin`")),
    );
    expect(origin).toBeGreaterThan(0);
    await applyMigrations(execute, MIGRATIONS.slice(0, origin));
    const capture = (id: string, kind: string) =>
      execute(
        "INSERT INTO captures (id, started_at, ended_at, kind, profile, complete, description, adapter, exchanges, document) VALUES (?, 0, 0, ?, NULL, 1, '', '', 0, x'00')",
        [id, kind],
        "run",
      );
    await capture("from-file", "import");
    await capture("from-car", "capture");
    const report = (id: string, adapter: string) =>
      execute(
        "INSERT INTO scan_reports (id, profile, adapter, taken_at, label, report) VALUES (?, 'p', ?, 0, '', '{}')",
        [id, adapter],
        "run",
      );
    await report("from-link", "shared://link");
    await report("from-adapter", "ble://adapter");
    await execute(
      "INSERT INTO runs (id, profile, adapter, started_at, stopped_at, notes) VALUES ('r', 'p', 'a', 0, NULL, '')",
      [],
      "run",
    );

    await applyMigrations(execute);
    expect(await execute("SELECT id, origin FROM captures ORDER BY id", [], "all")).toEqual([
      ["from-car", "local"],
      ["from-file", "imported"],
    ]);
    expect(await execute("SELECT id, origin FROM scan_reports ORDER BY id", [], "all")).toEqual([
      ["from-adapter", "local"],
      ["from-link", "shared"],
    ]);
    expect(await execute("SELECT origin FROM runs", [], "all")).toEqual([["local"]]);
    database.close();
  });
});

describe("the VIN migration", () => {
  /** Saved report documents of every shape the backfill reads, and some it must leave without a VIN. */
  const DOCUMENTS: Readonly<Record<string, Json>> = {
    generic: { obd: { vin: " simulatedcar00001 " }, units: [] },
    "generic-none": { obd: { vin: null }, units: [] },
    "generic-redacted": { obd: { vin: "" } },
    scan: {
      units: [
        { unit: "EZS", identification: { Part: { hex: "41", text: "A" } } },
        { unit: "ME", identification: { VIN: { hex: "", text: "wdb2110202b121724" } } },
        { unit: "TCU", identification: { VIN: { hex: "", text: "WDBOTHER000000000" } } },
      ],
    },
    "scan-redacted": { units: [{ identification: { VIN: { hex: "", text: "" } } }] },
    "obd-snapshot": { vin: "WVWZZZAAZJD000001", readiness: {} },
    "odd-units": { units: ["text", 1, null, { identification: ["VIN"] }] },
    "not-an-object": ["VIN"],
    none: { tool: "obd-read" },
    // Only ASCII letters change case and only ASCII white space is trimmed, so SQLite's upper and trim and reportVin agree on any text.
    accented: { obd: { vin: " wdbéx " } },
    "unicode-space": { obd: { vin: "\u00a0wdbx\u2003" } },
    "dotless-i": { obd: { vin: "wdbıx" } },
    "sharp-s": { obd: { vin: "wdbßx" } },
    "ascii-space": { obd: { vin: "\t\n wdbx \r" } },
  };

  it("fills each saved report's VIN from its document by the rule reportVin follows, and leaves runs and captures without one", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    const added = MIGRATIONS.findIndex((migration) =>
      migration.statements.some((statement) => statement.includes("ADD `vin`")),
    );
    expect(added).toBeGreaterThan(0);
    await applyMigrations(execute, MIGRATIONS.slice(0, added));
    for (const [id, document] of Object.entries(DOCUMENTS)) {
      await execute(
        "INSERT INTO scan_reports (id, profile, adapter, taken_at, label, report) VALUES (?, 'p', 'a', 0, '', ?)",
        [id, JSON.stringify(document)],
        "run",
      );
    }
    await execute(
      "INSERT INTO runs (id, profile, adapter, started_at, stopped_at, notes) VALUES ('r', 'p', 'a', 0, NULL, '')",
      [],
      "run",
    );
    await execute(
      "INSERT INTO captures (id, started_at, ended_at, kind, profile, complete, description, adapter, exchanges, document) VALUES ('c', 0, 0, 'capture', NULL, 1, '', '', 0, x'00')",
      [],
      "run",
    );

    await applyMigrations(execute);
    const filled = await execute("SELECT id, vin FROM scan_reports ORDER BY id", [], "all");
    expect(filled).toEqual(
      Object.entries(DOCUMENTS)
        .map(([id, document]) => [id, reportVin(document)])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(Object.fromEntries(filled.map(([id, vin]) => [id, vin]))).toMatchObject({
      generic: "SIMULATEDCAR00001",
      "generic-none": null,
      "generic-redacted": null,
      scan: "WDB2110202B121724",
      "scan-redacted": null,
      "obd-snapshot": "WVWZZZAAZJD000001",
      "odd-units": null,
      "not-an-object": null,
      none: null,
      accented: "WDBéX",
      "unicode-space": "\u00a0WDBX\u2003",
      "dotless-i": "WDBıX",
      "sharp-s": "WDBßX",
      "ascii-space": "WDBX",
    });
    expect(await execute("SELECT vin FROM runs", [], "all")).toEqual([[null]]);
    expect(await execute("SELECT vin FROM captures", [], "all")).toEqual([[null]]);
    database.close();
  });
});

describe("the schema", () => {
  it("refuses a sample holding both or neither of a numeric and a text value", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    await applyMigrations(execute);
    await execute(
      "INSERT INTO runs (id, profile, adapter, started_at, stopped_at, notes) VALUES ('r', 'p', 'a', 0, NULL, '')",
      [],
      "run",
    );
    const insert =
      "INSERT INTO samples (run_id, signal, unit, timestamp, value_num, value_text) VALUES ('r', 's', '', 0, ?, ?)";
    await expect(execute(insert, [1, "x"], "run")).rejects.toThrow(/CHECK/);
    await expect(execute(insert, [null, null], "run")).rejects.toThrow(/CHECK/);
    await execute(insert, [1, null], "run");
    database.close();
  });

  it("refuses a sample for an unknown run once foreign keys are on", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    await applyMigrations(execute);
    await expect(
      execute(
        "INSERT INTO samples (run_id, signal, unit, timestamp, value_num) VALUES ('x', 's', '', 0, 1)",
        [],
        "run",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    database.close();
  });
});

describe("a database file", () => {
  it("keeps runs and samples across a close and reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "obd-read-storage-"));
    try {
      const path = join(directory, "log.sqlite");
      const first = await openNodeStorage(path);
      const run = await first.createRun({ profile: "p", adapter: "a", startedAt: 1 });
      await first.appendSamples([
        { runId: run.id, signal: "s", unit: "V", timestamp: 2, value: 3.5 },
      ]);
      first.close();
      const second = await openNodeStorage(path);
      expect(await second.getRun(run.id)).toEqual(run);
      expect(await second.readSamples({ runId: run.id })).toHaveLength(1);
      second.close();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
