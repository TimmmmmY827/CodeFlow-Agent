import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../src/shared/contracts.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { translateStorageError } from "../src/storage/sqlite/sqlite-errors.js";
import {
  migrateStorage,
  STORAGE_SCHEMA_VERSION,
} from "../src/storage/sqlite/migrations.js";

const FIXED_TIMESTAMP = "2026-08-12T00:00:00.000Z" as const;
const clock: Clock = {
  utcNow: () => FIXED_TIMESTAMP,
  monotonicNowMs: () => 0,
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteStorageDatabase migrations", () => {
  it("migrates a fresh database once and remains idempotent when reopened", () => {
    const databasePath = temporaryDatabasePath();

    using first = new SqliteStorageDatabase(databasePath, { clock });
    expect(first.database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: STORAGE_SCHEMA_VERSION,
    });
    expect(
      first.database
        .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      {
        version: 1,
        name: "initial_storage",
        applied_at: FIXED_TIMESTAMP,
      },
    ]);

    first.close();
    using reopened = new SqliteStorageDatabase(databasePath, {
      clock: {
        ...clock,
        utcNow: () => "2026-08-13T00:00:00.000Z",
      },
    });

    expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual(
      { count: 1 },
    );
    expect(reopened.database.prepare("SELECT applied_at FROM schema_migrations").get()).toEqual({
      applied_at: FIXED_TIMESTAMP,
    });
  });

  it("fails closed when an applied migration checksum has drifted", () => {
    const databasePath = migratedDatabasePath();
    using tamper = new DatabaseSync(databasePath);
    tamper
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
      .run("sha256:tampered", 1);
    tamper.close();

    expectOpeningToFail(databasePath, "does not match its recorded checksum");

    using inspection = new DatabaseSync(databasePath);
    expect(inspection.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get()).toEqual({
      checksum: "sha256:tampered",
    });
  });

  it("fails closed when the database contains a newer migration", () => {
    const databasePath = migratedDatabasePath();
    using newer = new DatabaseSync(databasePath);
    newer
      .prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(2, "future_storage", "sha256:future", FIXED_TIMESTAMP);
    newer.exec("PRAGMA user_version = 2");
    newer.close();

    expectOpeningToFail(databasePath, "newer than this application");

    using inspection = new DatabaseSync(databasePath);
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 2,
    });
    expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  });

  it("fails closed when PRAGMA user_version disagrees with migration history", () => {
    const databasePath = migratedDatabasePath();
    using tamper = new DatabaseSync(databasePath);
    tamper.exec("PRAGMA user_version = 0");
    tamper.close();

    expectOpeningToFail(databasePath, "disagrees with migration history");
  });

  it("enables durability, locking and integrity pragmas for a file database", () => {
    const databasePath = temporaryDatabasePath();
    using storage = new SqliteStorageDatabase(databasePath, {
      clock,
      busyTimeoutMs: 1_739,
    });

    expect(storage.database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(storage.database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(storage.database.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(storage.database.prepare("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
    expect(storage.database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 1_739 });
  });

  it("physically purges deleted content from the main database and WAL", () => {
    const databasePath = temporaryDatabasePath();
    const mainSecret = "main-secret-7dbbdb03-32a4-4acb-8265-6573783d84c8";
    const walSecret = "wal-secret-a0becb96-e2e5-4de6-8c06-e24f6801587e";
    using storage = new SqliteStorageDatabase(databasePath, { clock, busyTimeoutMs: 5 });
    storage.database.exec("CREATE TABLE physical_purge_fixture(secret TEXT NOT NULL)");

    storage.database.prepare("INSERT INTO physical_purge_fixture(secret) VALUES (?)").run(mainSecret);
    storage.purgeDeletedContent();
    expect(fileContains(databasePath, mainSecret)).toBe(true);

    storage.database.prepare("DELETE FROM physical_purge_fixture WHERE secret = ?").run(mainSecret);
    storage.database.prepare("INSERT INTO physical_purge_fixture(secret) VALUES (?)").run(walSecret);
    storage.database.prepare("DELETE FROM physical_purge_fixture WHERE secret = ?").run(walSecret);
    expect(fileContains(`${databasePath}-wal`, walSecret)).toBe(true);

    storage.purgeDeletedContent();

    for (const secret of [mainSecret, walSecret]) {
      expect(fileContains(databasePath, secret)).toBe(false);
      expect(fileContains(`${databasePath}-wal`, secret)).toBe(false);
    }
    expect(readFileSync(`${databasePath}-wal`).byteLength).toBe(0);
  });

  it("fails closed while a reader prevents truncating deleted WAL content", () => {
    const databasePath = temporaryDatabasePath();
    const secret = "reader-held-secret-b129749f-b4cc-45cc-ad39-cd41c0dba2f0";
    using storage = new SqliteStorageDatabase(databasePath, { clock, busyTimeoutMs: 1 });
    storage.database.exec("CREATE TABLE physical_purge_fixture(secret TEXT NOT NULL)");
    storage.database.prepare("INSERT INTO physical_purge_fixture(secret) VALUES (?)").run(secret);
    storage.purgeDeletedContent();

    using reader = new DatabaseSync(databasePath, { timeout: 1 });
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT secret FROM physical_purge_fixture").get()).toEqual({ secret });
    storage.database.prepare("DELETE FROM physical_purge_fixture").run();

    expect(() => storage.purgeDeletedContent()).toThrowError(expect.objectContaining({
      details: expect.objectContaining({
        category: "physical_purge_pending",
        retryable: true,
      }),
    }));
    expect(fileContains(databasePath, secret)).toBe(true);

    reader.exec("ROLLBACK");
    expect(() => storage.purgeDeletedContent()).not.toThrow();
    expect(fileContains(databasePath, secret)).toBe(false);
    expect(fileContains(`${databasePath}-wal`, secret)).toBe(false);
  });

  it("rejects an invalid busy timeout before interpolating a PRAGMA", () => {
    expect(() => new SqliteStorageDatabase(":memory:", {
      clock,
      busyTimeoutMs: Number.NaN,
    })).toThrowError(RangeError);
    expect(() => new SqliteStorageDatabase(":memory:", {
      clock,
      busyTimeoutMs: -1,
    })).toThrowError(RangeError);
  });

  it("rolls back every statement and migration record when a migration fails", () => {
    using database = new DatabaseSync(":memory:");
    let createCount = 0;
    database.setAuthorizer((actionCode) => {
      // schema_migrations and workspaces are created first; deny sessions so
      // the test observes whether prior bootstrap/migration DDL is rolled back.
      if (actionCode === 2 && ++createCount === 3) return 1;
      return 0;
    });

    expect(() => migrateStorage(database, clock)).toThrowError(
      expect.objectContaining({
        name: "StorageError",
        details: expect.objectContaining({ category: "migration_failed" }),
      }),
    );

    expect(database.isTransaction).toBe(false);
    expect(tableNames(database)).not.toContain("schema_migrations");
    expect(tableNames(database)).not.toContain("workspaces");
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    database.setAuthorizer(null);
  });

  it("serializes the complete bootstrap and re-reads history after acquiring the lock", () => {
    const databasePath = temporaryDatabasePath();
    using first = new DatabaseSync(databasePath, { timeout: 50 });
    using second = new DatabaseSync(databasePath, { timeout: 50 });
    let secondFailure: unknown;

    migrateStorage(first, clock, {
      afterLockAcquired: () => {
        try {
          migrateStorage(second, clock);
        } catch (error: unknown) {
          secondFailure = error;
        }
      },
    });

    expect(secondFailure).toMatchObject({
      details: { category: "storage_busy", retryable: true },
    });
    // Once the first writer commits, the same connection re-enters migration,
    // acquires the lock and observes version 1 rather than a stale empty list.
    expect(() => migrateStorage(second, clock)).not.toThrow();
    expect(second.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 1,
    });
    expect(second.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  });

  it("fails a historical D1 schema with an explicit export-and-reinitialize recovery", () => {
    const databasePath = temporaryDatabasePath();
    using legacy = new DatabaseSync(databasePath);
    legacy.exec(`
CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL);
CREATE TABLE sessions(session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);`);
    legacy.close();

    let thrown: unknown;
    try {
      const storage = new SqliteStorageDatabase(databasePath, { clock });
      storage.close();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      details: {
        category: "migration_failed",
        recovery: expect.stringContaining("export any required historical Sessions"),
      },
    });
    using inspection = new DatabaseSync(databasePath);
    expect(tableNames(inspection)).not.toContain("schema_migrations");
    expect(tableNames(inspection)).toContain("sessions");
  });

  it("recognizes a legacy schema even if an old bootstrap left an empty history table", () => {
    const databasePath = temporaryDatabasePath();
    using legacy = new DatabaseSync(databasePath);
    legacy.exec(`
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE sessions(session_id TEXT PRIMARY KEY);`);
    legacy.close();

    let thrown: unknown;
    try {
      const storage = new SqliteStorageDatabase(databasePath, { clock });
      storage.close();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      details: {
        category: "migration_failed",
        recovery: expect.stringContaining("historical Sessions"),
      },
    });
  });
});

describe("SQLite error translation", () => {
  it.each([
    [5, "storage_busy", true],
    [6, "storage_busy", true],
    [8, "storage_read_only", false],
    [10, "storage_io_failed", false],
    [11, "storage_corrupt", false],
    [13, "disk_full", false],
    [19, "storage_constraint_failed", false],
    [26, "storage_corrupt", false],
    [2067, "storage_constraint_failed", false],
  ] as const)("maps SQLite errcode %i structurally", (errcode, category, retryable) => {
    const error = Object.assign(new Error("opaque SQLite failure"), {
      code: "ERR_SQLITE_ERROR",
      errcode,
      errstr: "opaque",
    });
    expect(translateStorageError(error)).toMatchObject({
      details: { category, retryable },
    });
  });

  it("does not classify ordinary programming exceptions as storage I/O", () => {
    expect(translateStorageError(new TypeError("invalid caller value"))).toMatchObject({
      details: { category: "storage_operation_failed", retryable: false },
    });
  });
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codeflow-storage-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "storage.sqlite");
}

function migratedDatabasePath(): string {
  const databasePath = temporaryDatabasePath();
  using storage = new SqliteStorageDatabase(databasePath, { clock });
  storage.close();
  return databasePath;
}

function expectOpeningToFail(databasePath: string, message: string): void {
  let thrown: unknown;
  try {
    const storage = new SqliteStorageDatabase(databasePath, { clock });
    storage.close();
  } catch (error: unknown) {
    thrown = error;
  }

  expect(thrown).toMatchObject({
    name: "StorageError",
    message: expect.stringContaining(message),
    details: {
      category: "migration_failed",
      retryable: false,
      sideEffectStatus: "none",
    },
  });
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

function fileContains(filePath: string, text: string): boolean {
  return existsSync(filePath) && readFileSync(filePath).includes(Buffer.from(text));
}
