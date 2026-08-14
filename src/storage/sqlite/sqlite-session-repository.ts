import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AgentEvent } from "../../events/agent-event.js";
import { reduceAgentEvents } from "../../events/state-reducer.js";
import {
  stableIdSchema,
  utcTimestampSchema,
  type StableId,
} from "../../shared/contracts.js";
import { canonicalJson } from "../../shared/json.js";
import type {
  CreateSessionBundle,
  DeletedSessionIdentity,
  DeleteReceipt,
  SessionFilter,
  SessionRecord,
  SessionDeletionCoordinator,
  SessionRepository,
  SessionSummary,
  WorkspaceRecord,
} from "../contracts.js";
import { STORAGE_RECORD_SCHEMA_VERSION } from "../contracts.js";
import { createSessionBundleSchema } from "../schemas.js";
import { SqliteStorageDatabase } from "./sqlite-database.js";
import {
  decodeAgentEvent,
  type StoredAgentEventRow,
} from "./sqlite-event-codec.js";
import { StorageError, storageError, translateStorageError } from "./sqlite-errors.js";

type SqlValue = string | number | bigint | null;

interface SessionRow extends Record<string, SqlValue> {
  readonly session_id: string;
  readonly schema_version: number;
  readonly workspace_id: string;
  readonly goal: string;
  readonly pinned: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
  readonly config_version: string;
  readonly tool_catalog_hash: string;
  readonly create_bundle_hash: string;
  readonly last_sequence: number;
  readonly deletion_state: string;
  readonly normalized_path: string;
  readonly display_path: string;
  readonly workspace_fingerprint: string;
  readonly workspace_created_at: string;
  readonly workspace_schema_version: number;
}

interface ListCursorPayload {
  readonly version: 1;
  readonly filterHash: string;
  readonly updatedAt: string;
  readonly sessionId: string;
}

/**
 * SQLite-backed owner of Workspace/Session metadata. Event append after creation
 * remains the responsibility of SqliteEventStore; this class only creates the
 * root Session bundle atomically.
 */
export class SqliteSessionRepository implements SessionRepository {
  readonly #storage: SqliteStorageDatabase;
  readonly #database: DatabaseSync;
  readonly #deletionCoordinator: SessionDeletionCoordinator | null;
  readonly #deletedSessionIdentity: DeletedSessionIdentity;

  constructor(
    storage: SqliteStorageDatabase,
    options: {
      readonly deletedSessionIdentity: DeletedSessionIdentity;
      readonly deletionCoordinator?: SessionDeletionCoordinator;
    },
  ) {
    this.#storage = storage;
    this.#database = storage.database;
    this.#deletionCoordinator = options.deletionCoordinator ?? null;
    this.#deletedSessionIdentity = options.deletedSessionIdentity;
  }

  async create(input: CreateSessionBundle): Promise<"inserted" | "duplicate"> {
    const parsed = createSessionBundleSchema.safeParse(input);
    if (!parsed.success) {
      throw storageError(
        "invalid_session_bundle",
        `Session creation bundle is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        false,
        "Correct the Workspace, Session, root Task and session.created identities before retrying.",
      );
    }

    const bundle = parsed.data;
    const bundleJson = canonicalJson(bundle);
    const bundleHash = sha256(bundleJson);

    try {
      this.#database.exec("BEGIN IMMEDIATE");

      const existing = this.#database
        .prepare("SELECT create_bundle_hash, deletion_state FROM sessions WHERE session_id = ?")
        .get(bundle.session.sessionId);
      if (existing) {
        if (readString(existing.deletion_state, "deletion_state") !== "active") {
          throw sessionNotFound(bundle.session.sessionId);
        }
        const storedBundleJson = canonicalJson(this.#readCreationBundle(bundle.session.sessionId));
        const storedBundleHash = sha256(storedBundleJson);
        if (readString(existing.create_bundle_hash, "create_bundle_hash") !== storedBundleHash) {
          throw storageError(
            "storage_corrupt",
            `Session ${bundle.session.sessionId} creation hash disagrees with its durable records.`,
            false,
            "Stop writes and inspect or restore the Session creation records.",
          );
        }
        if (storedBundleHash === bundleHash && storedBundleJson === bundleJson) {
          this.#database.exec("COMMIT");
          return "duplicate";
        }
        throw sessionConflict(
          "session_id_conflict",
          `Session ID ${bundle.session.sessionId} already belongs to a different creation bundle.`,
        );
      }

      if (this.#deletedSessionIdentity.hasDeletedSessionIdentity(bundle.session.sessionId)) {
        throw sessionConflict(
          "deleted_session_id_conflict",
          `Session ID ${bundle.session.sessionId} has a retained deletion tombstone and cannot be reused.`,
        );
      }

      this.#ensureWorkspace(bundle.session.workspace);
      this.#database
        .prepare(`
INSERT INTO sessions(
  session_id, schema_version, workspace_id, goal, pinned,
  created_at, updated_at, expires_at, config_version, tool_catalog_hash,
  create_bundle_hash, last_sequence, deletion_state
) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, 'active')`)
        .run(
          bundle.session.sessionId,
          bundle.session.schemaVersion,
          bundle.session.workspace.workspaceId,
          bundle.session.goal,
          bundle.session.createdAt,
          bundle.session.createdAt,
          bundle.session.expiresAt,
          bundle.session.configVersion,
          bundle.session.toolCatalogHash,
          bundleHash,
        );
      this.#database
        .prepare(`
INSERT INTO tasks(task_id, schema_version, session_id, parent_task_id, actor_id, title, created_at, create_record_hash)
VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`)
        .run(
          bundle.rootTask.taskId,
          bundle.rootTask.schemaVersion,
          bundle.session.sessionId,
          bundle.rootTask.actorId,
          bundle.rootTask.title,
          bundle.rootTask.createdAt,
          sha256(canonicalJson({
            ...bundle.rootTask,
            sessionId: bundle.session.sessionId,
            parentTaskId: null,
          })),
        );
      this.#insertCreatedEvent(bundle.createdEvent);

      this.#database.exec("COMMIT");
      return "inserted";
    } catch (error: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw translateStorageError(error);
    }
  }

  async get(sessionId: StableId): Promise<SessionRecord | null> {
    stableIdSchema.parse(sessionId);
    try {
      const row = this.#selectSession(sessionId);
      return row ? this.#toSessionRecord(row) : null;
    } catch (error: unknown) {
      throw translateStorageError(error);
    }
  }

  async list(filter: SessionFilter): Promise<readonly SessionSummary[]> {
    validateFilter(filter);
    try {
      const cursor = filter.cursor ? decodeCursor(filter.cursor, filter) : null;
      const conditions = ["s.deletion_state = 'active'"];
      const parameters: SqlValue[] = [];
      if (filter.workspaceId !== undefined) {
        conditions.push("s.workspace_id = ?");
        parameters.push(filter.workspaceId);
      }
      if (filter.pinned !== undefined) {
        conditions.push("s.pinned = ?");
        parameters.push(filter.pinned ? 1 : 0);
      }
      if (filter.updatedBefore !== undefined) {
        conditions.push("s.updated_at < ?");
        parameters.push(filter.updatedBefore);
      }
      if (cursor) {
        conditions.push("(s.updated_at < ? OR (s.updated_at = ? AND s.session_id < ?))");
        parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.sessionId);
      }

      const rows = this.#database
        .prepare(`${SESSION_SELECT}\nWHERE ${conditions.join(" AND ")}\nORDER BY s.updated_at DESC, s.session_id DESC`)
        .all(...parameters)
        .map((row) => requireSessionRow(row));
      const accepted: SessionSummary[] = [];
      for (const row of rows) {
        const record = this.#toSessionRecord(row);
        if (filter.lifecycle && !filter.lifecycle.includes(record.lifecycle)) continue;
        accepted.push(toSummary(record));
        if (accepted.length === filter.limit) break;
      }
      return accepted;
    } catch (error: unknown) {
      throw translateStorageError(error);
    }
  }

  async setPinned(
    sessionId: StableId,
    pinned: boolean,
    unpinnedExpiresAt?: string,
  ): Promise<void> {
    stableIdSchema.parse(sessionId);
    if (!pinned && unpinnedExpiresAt === undefined) {
      throw storageError(
        "retention_expiry_required",
        "Unpinning requires the retention policy to provide a new expiresAt timestamp.",
        false,
        "Calculate expiresAt from the current retention policy and injected Clock.",
      );
    }
    if (unpinnedExpiresAt !== undefined) utcTimestampSchema.parse(unpinnedExpiresAt);
    try {
      const result = this.#database
        .prepare(`
UPDATE sessions
SET pinned = ?, expires_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
    updated_at = ?
WHERE session_id = ? AND deletion_state = 'active'`)
        .run(
          pinned ? 1 : 0,
          pinned ? 1 : 0,
          unpinnedExpiresAt ?? null,
          this.#storage.clock.utcNow(),
          sessionId,
        );
      if (result.changes === 0) throw sessionNotFound(sessionId);
    } catch (error: unknown) {
      throw translateStorageError(error);
    }
  }

  async delete(sessionId: StableId): Promise<DeleteReceipt> {
    stableIdSchema.parse(sessionId);
    if (this.#deletionCoordinator) return this.#deletionCoordinator.delete(sessionId);
    throw storageError(
      "session_delete_requires_coordinator",
      `Session ${sessionId} cannot be safely deleted by the metadata repository alone.`,
      false,
      "Use SessionDeletionService so Artifact files, metadata and the durable receipt are coordinated.",
    );
  }

  #ensureWorkspace(workspace: WorkspaceRecord): void {
    const byId = this.#database
      .prepare(`
SELECT schema_version, normalized_path, display_path, fingerprint, created_at
FROM workspaces WHERE workspace_id = ?`)
      .get(workspace.workspaceId);
    if (byId) {
      const stored = canonicalJson({
        schemaVersion: readInteger(byId.schema_version, "workspace schema version"),
        workspaceId: workspace.workspaceId,
        root: {
          normalizedPath: readString(byId.normalized_path, "normalized_path"),
          displayPath: readString(byId.display_path, "display_path"),
        },
        fingerprint: readString(byId.fingerprint, "fingerprint"),
        createdAt: readString(byId.created_at, "created_at"),
      });
      if (stored !== canonicalJson(workspace)) {
        throw sessionConflict(
          "workspace_id_conflict",
          `Workspace ID ${workspace.workspaceId} is already bound to different metadata.`,
        );
      }
      return;
    }

    const pathOwner = this.#database
      .prepare("SELECT workspace_id FROM workspaces WHERE normalized_path = ?")
      .get(workspace.root.normalizedPath);
    if (pathOwner) {
      throw sessionConflict(
        "workspace_path_conflict",
        `Workspace path ${workspace.root.displayPath} is already bound to another Workspace ID.`,
      );
    }
    this.#database
      .prepare(`
INSERT INTO workspaces(
  workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at
) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        workspace.workspaceId,
        workspace.schemaVersion,
        workspace.root.normalizedPath,
        workspace.root.displayPath,
        workspace.fingerprint,
        workspace.createdAt,
      );
  }

  #insertCreatedEvent(event: AgentEvent): void {
    const eventJson = canonicalJson(event);
    this.#database
      .prepare(`
INSERT INTO agent_events(
  event_id, session_id, task_id, sequence, event_type, schema_version,
  occurred_at, trace_id, span_id, parent_span_id, event_hash, event_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.eventId,
        event.sessionId,
        event.taskId,
        event.sequence,
        event.type,
        event.schemaVersion,
        event.occurredAt,
        event.traceId,
        event.spanId,
        event.parentSpanId,
        sha256(eventJson),
        eventJson,
      );
  }

  #selectSession(sessionId: StableId): SessionRow | null {
    const row = this.#database
      .prepare(`${SESSION_SELECT}\nWHERE s.session_id = ? AND s.deletion_state = 'active'`)
      .get(sessionId);
    return row ? requireSessionRow(row) : null;
  }

  #readCreationBundle(sessionId: StableId): CreateSessionBundle {
    const row = this.#database
      .prepare(`${SESSION_SELECT}\nWHERE s.session_id = ?`)
      .get(sessionId);
    if (!row) throw sessionNotFound(sessionId);
    const session = requireSessionRow(row);
    const roots = this.#database
      .prepare(`
SELECT task_id, schema_version, actor_id, title, created_at, create_record_hash
FROM tasks WHERE session_id = ? AND parent_task_id IS NULL ORDER BY task_id`)
      .all(sessionId);
    if (roots.length !== 1) {
      throw storageError(
        "storage_corrupt",
        `Session ${sessionId} must have exactly one root Task.`,
        false,
        "Stop writes and inspect or restore the Session Task records.",
      );
    }
    const root = roots[0]!;
    const rootTask = {
      schemaVersion: readSchemaVersion(root.schema_version, "root Task schema version"),
      taskId: stableIdSchema.parse(root.task_id),
      actorId: readString(root.actor_id, "root Task actor_id"),
      title: readString(root.title, "root Task title"),
      createdAt: utcTimestampSchema.parse(root.created_at),
    };
    const rootRecordJson = canonicalJson({
      ...rootTask,
      sessionId,
      parentTaskId: null,
    });
    if (readString(root.create_record_hash, "root Task create_record_hash") !== sha256(rootRecordJson)) {
      throw storageError(
        "storage_corrupt",
        `Session ${sessionId} root Task hash disagrees with its durable record.`,
        false,
        "Stop writes and inspect or restore the root Task record.",
      );
    }
    const eventRows = this.#database
      .prepare(`${EVENT_SELECT} WHERE session_id = ? AND sequence = 0`)
      .all(sessionId);
    if (eventRows.length !== 1) {
      throw storageError(
        "storage_corrupt",
        `Session ${sessionId} must have exactly one sequence-zero event.`,
        false,
        "Stop writes and inspect or restore the Session creation event.",
      );
    }
    return {
      session: {
        schemaVersion: readSchemaVersion(session.schema_version, "Session schema version"),
        sessionId: stableIdSchema.parse(session.session_id),
        workspace: {
          schemaVersion: readSchemaVersion(
            session.workspace_schema_version,
            "Workspace schema version",
          ),
          workspaceId: stableIdSchema.parse(session.workspace_id),
          root: {
            normalizedPath: session.normalized_path,
            displayPath: session.display_path,
          },
          fingerprint: session.workspace_fingerprint,
          createdAt: utcTimestampSchema.parse(session.workspace_created_at),
        },
        goal: session.goal,
        createdAt: utcTimestampSchema.parse(session.created_at),
        expiresAt: session.expires_at === null
          ? null
          : utcTimestampSchema.parse(session.expires_at),
        configVersion: session.config_version,
        toolCatalogHash: session.tool_catalog_hash,
      },
      rootTask,
      createdEvent: decodeAgentEvent(eventRows[0]! as unknown as StoredAgentEventRow),
    };
  }

  #toSessionRecord(row: SessionRow): SessionRecord {
    const workspace: WorkspaceRecord = {
      schemaVersion: readSchemaVersion(row.workspace_schema_version, "Workspace schema version"),
      workspaceId: stableIdSchema.parse(row.workspace_id),
      root: {
        normalizedPath: row.normalized_path,
        displayPath: row.display_path,
      },
      fingerprint: row.workspace_fingerprint,
      createdAt: utcTimestampSchema.parse(row.workspace_created_at),
    };
    const events = this.#readEvents(row.session_id);
    const view = reduceAgentEvents(events);
    if (!view) {
      throw storageError(
        "trace_incomplete",
        `Session ${row.session_id} has no initial event.`,
        false,
        "Restore the immutable Session facts before reading its projection.",
      );
    }
    if (view.lastSequence !== row.last_sequence) {
      throw storageError(
        "session_projection_mismatch",
        `Session ${row.session_id} metadata ends at ${row.last_sequence}, but its trace ends at ${view.lastSequence}.`,
        false,
        "Rebuild the Session metadata projection from immutable events.",
      );
    }
    return {
      schemaVersion: readSchemaVersion(row.schema_version, "Session schema version"),
      sessionId: stableIdSchema.parse(row.session_id),
      workspace,
      goal: row.goal,
      createdAt: utcTimestampSchema.parse(row.created_at),
      expiresAt: row.expires_at === null ? null : utcTimestampSchema.parse(row.expires_at),
      configVersion: row.config_version,
      toolCatalogHash: row.tool_catalog_hash,
      lifecycle: view.status,
      updatedAt: utcTimestampSchema.parse(row.updated_at),
      pinned: row.pinned === 1,
      lastSequence: row.last_sequence,
    };
  }

  #readEvents(sessionId: string): readonly AgentEvent[] {
    return this.#database
      .prepare(`${EVENT_SELECT} WHERE session_id = ? ORDER BY sequence`)
      .all(sessionId)
      .map((row) => decodeAgentEvent(row as unknown as StoredAgentEventRow));
  }
}

const SESSION_SELECT = `
SELECT
  s.session_id, s.schema_version, s.workspace_id, s.goal, s.pinned,
  s.created_at, s.updated_at, s.expires_at, s.config_version,
  s.tool_catalog_hash, s.create_bundle_hash, s.last_sequence, s.deletion_state,
  w.schema_version AS workspace_schema_version,
  w.normalized_path, w.display_path, w.fingerprint AS workspace_fingerprint,
  w.created_at AS workspace_created_at
FROM sessions s
JOIN workspaces w ON w.workspace_id = s.workspace_id`;

function requireSessionRow(row: Readonly<Record<string, unknown>>): SessionRow {
  return {
    session_id: readString(row.session_id, "session_id"),
    schema_version: readInteger(row.schema_version, "session schema version"),
    workspace_id: readString(row.workspace_id, "workspace_id"),
    goal: readString(row.goal, "goal"),
    pinned: readInteger(row.pinned, "pinned"),
    created_at: readString(row.created_at, "created_at"),
    updated_at: readString(row.updated_at, "updated_at"),
    expires_at: readNullableString(row.expires_at, "expires_at"),
    config_version: readString(row.config_version, "config_version"),
    tool_catalog_hash: readString(row.tool_catalog_hash, "tool_catalog_hash"),
    create_bundle_hash: readString(row.create_bundle_hash, "create_bundle_hash"),
    last_sequence: readInteger(row.last_sequence, "last_sequence"),
    deletion_state: readString(row.deletion_state, "deletion_state"),
    normalized_path: readString(row.normalized_path, "normalized_path"),
    display_path: readString(row.display_path, "display_path"),
    workspace_fingerprint: readString(row.workspace_fingerprint, "workspace_fingerprint"),
    workspace_created_at: readString(row.workspace_created_at, "workspace_created_at"),
    workspace_schema_version: readInteger(
      row.workspace_schema_version,
      "Workspace schema version",
    ),
  };
}

const EVENT_SELECT = `SELECT event_id, session_id, task_id, sequence, event_type,
  schema_version, occurred_at, trace_id, span_id, parent_span_id, event_hash, event_json
  FROM agent_events`;

function validateFilter(filter: SessionFilter): void {
  if (!Number.isSafeInteger(filter.limit) || filter.limit <= 0 || filter.limit > 1_000) {
    throw storageError(
      "invalid_session_filter",
      "Session list limit must be an integer from 1 through 1000.",
      false,
      "Use a bounded positive list limit.",
    );
  }
  if (filter.workspaceId !== undefined) stableIdSchema.parse(filter.workspaceId);
  if (filter.updatedBefore !== undefined) utcTimestampSchema.parse(filter.updatedBefore);
  if (filter.lifecycle !== undefined) {
    const allowed = new Set([
      "CREATED", "RUNNING", "WAITING_USER", "WAITING_APPROVAL", "VERIFYING",
      "COMPLETION_CLAIMED", "COMPLETION_VERIFIED", "CANCELLING", "CANCELLED",
      "FAILED", "UNKNOWN",
    ]);
    if (filter.lifecycle.some((lifecycle) => !allowed.has(lifecycle))) {
      throw storageError(
        "invalid_session_filter",
        "Session lifecycle filter contains an unsupported value.",
        false,
        "Use only lifecycle values from the C01 SessionLifecycle contract.",
      );
    }
  }
}

/** Cursor helper for future callers; the current result contract intentionally
 * remains an array, so callers derive the next cursor from the last summary. */
export function createSessionListCursor(
  filter: Omit<SessionFilter, "cursor">,
  last: Pick<SessionSummary, "updatedAt" | "sessionId">,
): string {
  const payload: ListCursorPayload = {
    version: 1,
    filterHash: filterHash(filter),
    updatedAt: last.updatedAt,
    sessionId: last.sessionId,
  };
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, filter: SessionFilter): ListCursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1) throw new Error("unsupported cursor version");
    const payload: ListCursorPayload = {
      version: 1,
      filterHash: readString(candidate.filterHash, "cursor filterHash"),
      updatedAt: utcTimestampSchema.parse(candidate.updatedAt),
      sessionId: stableIdSchema.parse(candidate.sessionId),
    };
    if (payload.filterHash !== filterHash(withoutCursor(filter))) {
      throw new Error("cursor does not match this filter");
    }
    return payload;
  } catch (error: unknown) {
    if (error instanceof StorageError) throw error;
    throw storageError(
      "invalid_session_cursor",
      `Session list cursor is invalid: ${error instanceof Error ? error.message : String(error)}`,
      false,
      "Restart listing without the invalid cursor.",
    );
  }
}

function withoutCursor(filter: SessionFilter): Omit<SessionFilter, "cursor"> {
  const { cursor: _cursor, ...rest } = filter;
  return rest;
}

function filterHash(filter: Omit<SessionFilter, "cursor">): string {
  return sha256(canonicalJson(filter));
}

function toSummary(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.sessionId,
    workspaceId: record.workspace.workspaceId,
    goal: record.goal,
    lifecycle: record.lifecycle,
    updatedAt: record.updatedAt,
    pinned: record.pinned,
    lastSequence: record.lastSequence,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw storageError("storage_corrupt", `Stored ${label} is invalid.`, false, "Inspect or restore the database.");
  }
  return value;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readString(value, label);
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw storageError("storage_corrupt", `Stored ${label} is invalid.`, false, "Inspect or restore the database.");
  }
  return value;
}

function readSchemaVersion(
  value: unknown,
  label: string,
): typeof STORAGE_RECORD_SCHEMA_VERSION {
  const version = readInteger(value, label);
  if (version !== STORAGE_RECORD_SCHEMA_VERSION) {
    throw storageError(
      "storage_schema_unsupported",
      `${label} ${version} is not supported.`,
      false,
      "Open the data with a compatible application version or run a supported migration.",
    );
  }
  return version;
}

function sessionConflict(category: string, message: string): StorageError {
  return storageError(category, message, false, "Use a new stable ID or inspect the existing Session record.");
}

function sessionNotFound(sessionId: StableId): StorageError {
  return storageError(
    "session_not_found",
    `Session ${sessionId} does not exist or is being deleted.`,
    false,
    "Reload the Session list before retrying.",
  );
}
