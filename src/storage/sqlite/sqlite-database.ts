import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { systemClock, type Clock } from "../../shared/contracts.js";
import { migrateStorage } from "./migrations.js";
import { storageError, translateStorageError } from "./sqlite-errors.js";

export { StorageError, storageError, translateStorageError } from "./sqlite-errors.js";

export interface OpenSqliteStorageOptions {
  readonly clock?: Clock;
  readonly busyTimeoutMs?: number;
}

export class SqliteStorageDatabase implements Disposable {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly databasePath: string | null;

  constructor(databasePath: string, options: OpenSqliteStorageOptions = {}) {
    const resolvedPath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
    const busyTimeoutMs = validateBusyTimeout(options.busyTimeoutMs ?? 5_000);
    this.clock = options.clock ?? systemClock;
    this.databasePath = resolvedPath === ":memory:" ? null : resolvedPath;
    let database: DatabaseSync;
    try {
      if (resolvedPath !== ":memory:") mkdirSync(path.dirname(resolvedPath), { recursive: true });
      database = new DatabaseSync(resolvedPath, {
        allowExtension: false,
        enableForeignKeyConstraints: true,
        timeout: busyTimeoutMs,
      });
    } catch (error: unknown) {
      throw translateStorageError(error);
    }
    this.database = database;
    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      if (resolvedPath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec("PRAGMA secure_delete = ON");
      migrateStorage(this.database, this.clock);
      this.completePendingPhysicalPurges();
      if (typeof this.database.enableDefensive === "function") {
        this.database.enableDefensive(true);
      }
    } catch (error: unknown) {
      this.database.close();
      throw translateStorageError(error);
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  /**
   * Makes logically deleted SQLite content no longer recoverable from the
   * current database file or its WAL. Callers must not report a physical purge
   * as complete until this barrier succeeds.
   */
  purgeDeletedContent(): void {
    if (this.databasePath === null) return;

    try {
      const result = this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const checkpoint = parseWalCheckpoint(result);
      if (
        checkpoint.busy !== 0 ||
        checkpoint.log !== 0 ||
        checkpoint.checkpointed !== 0
      ) {
        throw storageError(
          "physical_purge_pending",
          `SQLite WAL purge is incomplete (busy=${checkpoint.busy}, log=${checkpoint.log}, checkpointed=${checkpoint.checkpointed}).`,
          true,
          "Close active database readers and retry the physical purge before reporting deletion complete.",
        );
      }
    } catch (error: unknown) {
      throw translateStorageError(error);
    }
  }

  completePendingPhysicalPurges(): number {
    const pending = this.database
      .prepare("SELECT COUNT(*) AS count FROM deleted_session_tombstones WHERE purge_state = 'pending'")
      .get()?.count;
    if (typeof pending !== "number" || !Number.isSafeInteger(pending) || pending < 0) {
      throw storageError(
        "storage_corrupt",
        "Pending physical purge count is invalid.",
        false,
        "Inspect the deletion tombstones before reopening storage.",
      );
    }
    if (pending === 0) return 0;

    this.purgeDeletedContent();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = this.database
        .prepare(`
UPDATE deleted_session_tombstones
SET purge_state = 'complete', purge_error_json = NULL
WHERE purge_state = 'pending'`)
        .run();
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error: unknown) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw translateStorageError(error);
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

function validateBusyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError("busyTimeoutMs must be an integer from 0 through 2147483647.");
  }
  return value;
}

interface WalCheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

function parseWalCheckpoint(
  row: Readonly<Record<string, unknown>> | undefined,
): WalCheckpointResult {
  if (
    row === undefined ||
    !isNonnegativeInteger(row.busy) ||
    !isNonnegativeInteger(row.log) ||
    !isNonnegativeInteger(row.checkpointed)
  ) {
    throw storageError(
      "physical_purge_failed",
      "SQLite returned an invalid WAL checkpoint result.",
      false,
      "Stop deletion completion and inspect the SQLite runtime before retrying.",
    );
  }
  return {
    busy: row.busy,
    log: row.log,
    checkpointed: row.checkpointed,
  };
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
