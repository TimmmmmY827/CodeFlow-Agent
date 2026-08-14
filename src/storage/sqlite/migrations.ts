import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "../../shared/contracts.js";
import { StorageError, translateStorageError } from "./sqlite-errors.js";

export const STORAGE_SCHEMA_VERSION = 1;

export interface MigrationHooks {
  /** Test-only observation point reached after the migration write lock is held. */
  readonly afterLockAcquired?: () => void;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_storage",
    sql: `
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  normalized_path TEXT NOT NULL UNIQUE,
  display_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  goal TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT CHECK (expires_at IS NULL OR (length(expires_at) = 24 AND expires_at GLOB '????-??-??T??:??:??.???Z')),
  config_version TEXT NOT NULL,
  tool_catalog_hash TEXT NOT NULL,
  create_bundle_hash TEXT NOT NULL CHECK (length(create_bundle_hash) = 71 AND create_bundle_hash LIKE 'sha256:%'),
  last_sequence INTEGER NOT NULL DEFAULT -1 CHECK (last_sequence >= -1),
  deletion_state TEXT NOT NULL DEFAULT 'active' CHECK (deletion_state IN ('active', 'deleting'))
);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  parent_task_id TEXT,
  actor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  create_record_hash TEXT NOT NULL CHECK (length(create_record_hash) = 71 AND create_record_hash LIKE 'sha256:%'),
  UNIQUE(task_id, session_id),
  FOREIGN KEY (parent_task_id, session_id) REFERENCES tasks(task_id, session_id)
);

CREATE TABLE agent_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24 AND occurred_at GLOB '????-??-??T??:??:??.???Z'),
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 71 AND event_hash LIKE 'sha256:%'),
  event_json TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('staged', 'ready', 'corrupt', 'deleting')),
  staged_relative_path TEXT,
  ready_relative_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 71 AND sha256 LIKE 'sha256:%'),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  verified_at TEXT CHECK (verified_at IS NULL OR (length(verified_at) = 24 AND verified_at GLOB '????-??-??T??:??:??.???Z')),
  error_json TEXT
);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  tool_name TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24 AND expires_at GLOB '????-??-??T??:??:??.???Z'),
  decided_at TEXT NOT NULL CHECK (length(decided_at) = 24 AND decided_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE usage_entries (
  usage_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  entry_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24 AND occurred_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE delete_receipts (
  receipt_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'complete', 'failed')),
  started_at TEXT NOT NULL CHECK (length(started_at) = 24 AND started_at GLOB '????-??-??T??:??:??.???Z'),
  completed_at TEXT CHECK (completed_at IS NULL OR (length(completed_at) = 24 AND completed_at GLOB '????-??-??T??:??:??.???Z')),
  UNIQUE(session_id)
);

CREATE TABLE delete_receipt_items (
  receipt_id TEXT NOT NULL REFERENCES delete_receipts(receipt_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target TEXT NOT NULL CHECK (target IN ('session', 'event', 'approval', 'usage', 'transcript', 'artifact_metadata', 'artifact_file')),
  reference_hash TEXT NOT NULL CHECK (length(reference_hash) = 71 AND reference_hash LIKE 'sha256:%'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'deleted', 'missing', 'failed')),
  error_json TEXT,
  PRIMARY KEY (receipt_id, ordinal)
);

CREATE TABLE deleted_session_tombstones (
  receipt_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  session_id_hash TEXT NOT NULL UNIQUE CHECK (length(session_id_hash) = 71 AND session_id_hash LIKE 'sha256:%'),
  requested_at TEXT NOT NULL CHECK (length(requested_at) = 24 AND requested_at GLOB '????-??-??T??:??:??.???Z'),
  completed_at TEXT NOT NULL CHECK (length(completed_at) = 24 AND completed_at GLOB '????-??-??T??:??:??.???Z'),
  final_status TEXT NOT NULL CHECK (final_status = 'complete'),
  target_counts_json TEXT NOT NULL,
  purge_state TEXT NOT NULL CHECK (purge_state IN ('pending', 'complete')),
  purge_error_json TEXT
);

CREATE TABLE storage_installation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  artifact_root_fingerprint TEXT,
  deletion_hash_key_id TEXT
);

INSERT INTO storage_installation(singleton, schema_version, artifact_root_fingerprint, deletion_hash_key_id)
VALUES (1, 1, NULL, NULL);

CREATE INDEX idx_agent_events_session_sequence ON agent_events(session_id, sequence);
CREATE INDEX idx_sessions_expiration ON sessions(pinned, expires_at);
CREATE INDEX idx_artifacts_session_state ON artifacts(session_id, state);
`,
  },
];

export function migrateStorage(
  database: DatabaseSync,
  clock: Clock,
  hooks: MigrationHooks = {},
): void {
  try {
    // SQLite serializes BEGIN IMMEDIATE before any schema/history observation.
    // Every waiter therefore re-reads migration state after the previous writer
    // commits instead of acting on a stale pre-lock snapshot.
    database.exec("BEGIN IMMEDIATE");
    hooks.afterLockAcquired?.();
    const tablesBeforeBootstrap = tableNames(database);

    database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`);

    const existing = database
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all();
    // Also catches databases left behind by an older failed bootstrap that
    // created an empty schema_migrations table outside its migration lock.
    if (existing.length === 0 && hasLegacyD1Schema(tablesBeforeBootstrap)) {
      throw legacySchemaError();
    }
    validateHistory(database, existing);

    for (const migration of migrations) {
      if (existing.some((row) => row.version === migration.version)) continue;
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, checksum(migration.sql), clock.utcNow());
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.exec("COMMIT");
  } catch (error: unknown) {
    if (database.isTransaction) database.exec("ROLLBACK");
    if (error instanceof StorageError) throw error;
    const translated = translateStorageError(error);
    if (isOperationalStorageFailure(translated)) throw translated;
    throw migrationError(error instanceof Error ? error.message : String(error));
  }
}

if (migrations.at(-1)?.version !== STORAGE_SCHEMA_VERSION) {
  throw new Error("STORAGE_SCHEMA_VERSION must match the latest migration version.");
}

function checksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

function validateHistory(
  database: DatabaseSync,
  existing: readonly Readonly<Record<string, unknown>>[],
): void {
  for (const row of existing) {
    const version = requireNumber(row.version, "migration version");
    const migration = migrations.find((candidate) => candidate.version === version);
    if (!migration) {
      throw migrationError(`Database schema version ${version} is newer than this application.`);
    }
    if (row.name !== migration.name || row.checksum !== checksum(migration.sql)) {
      throw migrationError(`Migration ${version} does not match its recorded checksum.`);
    }
  }

  for (let index = 0; index < existing.length; index += 1) {
    const expectedVersion = index + 1;
    if (requireNumber(existing[index]?.version, "migration version") !== expectedVersion) {
      throw migrationError(`Database migration history is missing version ${expectedVersion}.`);
    }
  }

  const userVersionRow = database.prepare("PRAGMA user_version").get();
  const userVersion = requireNumber(userVersionRow?.user_version, "PRAGMA user_version");
  const recordedVersion = existing.length === 0
    ? 0
    : requireNumber(existing.at(-1)?.version, "migration version");
  if (userVersion !== recordedVersion) {
    throw migrationError(
      `PRAGMA user_version ${userVersion} disagrees with migration history ${recordedVersion}.`,
    );
  }
}

function tableNames(database: DatabaseSync): ReadonlySet<string> {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
}

function hasLegacyD1Schema(tables: ReadonlySet<string>): boolean {
  return tables.has("sessions") || tables.has("agent_events") || tables.has("artifacts") ||
    tables.has("workspaces") || tables.has("tasks") || tables.has("approvals") ||
    tables.has("usage_entries");
}

function legacySchemaError(): StorageError {
  return new StorageError({
    category: "migration_failed",
    message: "Detected the unsupported historical D1 storage schema without migration history.",
    retryable: false,
    sideEffectStatus: "none",
    recovery: "Back up this database, export any required historical Sessions with a compatible build, then initialize a new C02 database. Do not run the historical schema.sql snapshot as a migration.",
  });
}

function isOperationalStorageFailure(error: StorageError): boolean {
  return error.details.category === "storage_busy" ||
    error.details.category === "disk_full" ||
    error.details.category === "storage_corrupt" ||
    error.details.category === "storage_read_only" ||
    error.details.category === "storage_io_failed";
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw migrationError(`Invalid ${label}.`);
  }
  return value;
}

function migrationError(message: string): StorageError {
  return new StorageError({
    category: "migration_failed",
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery: "Restore a compatible database backup or run a supported migration.",
  });
}
