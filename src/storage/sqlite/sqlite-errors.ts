import type { StructuredError } from "../../shared/contracts.js";

export class StorageError extends Error {
  readonly details: StructuredError;

  constructor(details: StructuredError) {
    super(details.message);
    this.name = "StorageError";
    this.details = details;
  }
}

export function translateStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const sqlite = sqliteErrorIdentity(error);
  if (!sqlite) {
    return storageError(
      "storage_operation_failed",
      message,
      false,
      "Inspect the application error and storage operation before retrying.",
    );
  }

  switch (sqlite.primaryCode) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return storageError(
        "storage_busy",
        message,
        true,
        "Retry after the active writer releases the storage lock.",
      );
    case SQLITE_FULL:
      return storageError(
        "disk_full",
        message,
        false,
        "Free disk space before resuming the Session.",
      );
    case SQLITE_CORRUPT:
    case SQLITE_NOTADB:
      return storageError(
        "storage_corrupt",
        message,
        false,
        "Stop writes and restore or inspect the database.",
      );
    case SQLITE_READONLY:
      return storageError(
        "storage_read_only",
        message,
        false,
        "Restore write access to the configured storage location.",
      );
    case SQLITE_IOERR:
      return storageError(
        "storage_io_failed",
        message,
        false,
        "Inspect the filesystem and storage device before retrying.",
      );
    case SQLITE_CONSTRAINT:
      return storageError(
        "storage_constraint_failed",
        message,
        false,
        "Inspect the conflicting durable identity or invalid stored relationship.",
      );
    default:
      return storageError(
        "storage_error",
        message,
        false,
        "Inspect the SQLite diagnostics before retrying.",
      );
  }
}

export function storageError(
  category: string,
  message: string,
  retryable: boolean,
  recovery: string | null,
): StorageError {
  return new StorageError({
    category,
    message,
    retryable,
    sideEffectStatus: "none",
    recovery,
  });
}

interface SqliteErrorIdentity {
  readonly primaryCode: number;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CONSTRAINT = 19;
const SQLITE_NOTADB = 26;

function sqliteErrorIdentity(error: unknown): SqliteErrorIdentity | null {
  if (readStringProperty(error, "code") !== "ERR_SQLITE_ERROR") return null;
  const extendedCode = readNumberProperty(error, "errcode");
  if (extendedCode === null || !Number.isSafeInteger(extendedCode) || extendedCode < 0) return null;
  return { primaryCode: extendedCode & 0xff };
}

function readStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : null;
}

function readNumberProperty(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" ? property : null;
}
