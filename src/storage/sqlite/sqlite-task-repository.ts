import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { stableIdSchema, utcTimestampSchema, type StableId } from "../../shared/contracts.js";
import { canonicalJson } from "../../shared/json.js";
import type { TaskRecord, TaskRepository } from "../contracts.js";
import { taskRecordSchema } from "../schemas.js";
import { SqliteStorageDatabase } from "./sqlite-database.js";
import { storageError, translateStorageError } from "./sqlite-errors.js";

/**
 * Persists non-root Tasks. The root Task is intentionally created only by
 * SqliteSessionRepository as part of the atomic Session creation bundle.
 */
export class SqliteTaskRepository implements TaskRepository {
  readonly #database: DatabaseSync;

  constructor(storage: SqliteStorageDatabase) {
    this.#database = storage.database;
  }

  async create(input: TaskRecord): Promise<"inserted" | "duplicate"> {
    const parsed = taskRecordSchema.safeParse(input);
    if (!parsed.success) {
      throw storageError(
        "invalid_task_record",
        `Task record is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        false,
        "Correct the Task fields before retrying.",
      );
    }
    const task = parsed.data;
    const recordHash = sha256(canonicalJson(task));
    if (task.parentTaskId === null) {
      throw storageError(
        "invalid_task_parent",
        "A non-root Task must reference its parent Task.",
        false,
        "Create the root Task through the atomic Session creation bundle.",
      );
    }
    if (task.parentTaskId === task.taskId) {
      throw storageError(
        "invalid_task_parent",
        "A Task cannot be its own parent.",
        false,
        "Reference an existing Task from the same Session.",
      );
    }

    try {
      this.#database.exec("BEGIN IMMEDIATE");

      const existing = this.#database
        .prepare(`
SELECT task_id, schema_version, session_id, parent_task_id, actor_id, title,
       created_at, create_record_hash
FROM tasks WHERE task_id = ?`)
        .get(task.taskId);
      if (existing) {
        const storedRecord = toTaskRecord(existing);
        const storedJson = canonicalJson(storedRecord);
        const storedHash = sha256(storedJson);
        if (readString(existing.create_record_hash, "create_record_hash") !== storedHash) {
          throw storageError(
            "storage_corrupt",
            `Task ${task.taskId} creation hash disagrees with its durable record.`,
            false,
            "Stop writes and inspect or restore the Task record.",
          );
        }
        if (storedHash === recordHash && storedJson === canonicalJson(task)) {
          this.#database.exec("COMMIT");
          return "duplicate";
        }
        throw taskConflict(
          "task_id_conflict",
          `Task ID ${task.taskId} already belongs to a different Task record.`,
        );
      }

      const session = this.#database
        .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
        .get(task.sessionId);
      if (!session) {
        throw storageError(
          "session_not_found",
          `Session ${task.sessionId} does not exist.`,
          false,
          "Create the Session before adding Tasks.",
        );
      }
      if (readString(session.deletion_state, "deletion_state") !== "active") {
        throw storageError(
          "session_deleting",
          `Session ${task.sessionId} is being deleted and cannot accept new Tasks.`,
          false,
          "Wait for deletion to finish or use another active Session.",
        );
      }

      const parent = this.#database
        .prepare("SELECT session_id FROM tasks WHERE task_id = ?")
        .get(task.parentTaskId);
      if (!parent) {
        throw storageError(
          "parent_task_not_found",
          `Parent Task ${task.parentTaskId} does not exist.`,
          false,
          "Create the parent Task before creating its child.",
        );
      }
      if (readString(parent.session_id, "parent session_id") !== task.sessionId) {
        throw storageError(
          "cross_session_parent_task",
          `Parent Task ${task.parentTaskId} belongs to another Session.`,
          false,
          "Choose a parent Task from the same Session.",
        );
      }

      this.#database
        .prepare(`
INSERT INTO tasks(
  task_id, schema_version, session_id, parent_task_id, actor_id, title, created_at, create_record_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          task.taskId,
          task.schemaVersion,
          task.sessionId,
          task.parentTaskId,
          task.actorId,
          task.title,
          task.createdAt,
          recordHash,
        );
      this.#database.exec("COMMIT");
      return "inserted";
    } catch (error: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw translateStorageError(error);
    }
  }

  async get(taskId: StableId): Promise<TaskRecord | null> {
    try {
      const checkedTaskId = stableIdSchema.parse(taskId);
      return this.#selectTask(checkedTaskId);
    } catch (error: unknown) {
      throw translateStorageError(error);
    }
  }

  async list(sessionId: StableId): Promise<readonly TaskRecord[]> {
    try {
      const checkedSessionId = stableIdSchema.parse(sessionId);
      return this.#database
        .prepare(`
SELECT task_id, schema_version, session_id, parent_task_id, actor_id, title, created_at,
       create_record_hash
FROM tasks
WHERE session_id = ?
ORDER BY created_at, task_id`)
        .all(checkedSessionId)
        .map(verifyStoredTaskRecord);
    } catch (error: unknown) {
      throw translateStorageError(error);
    }
  }

  #selectTask(taskId: StableId): TaskRecord | null {
    const row = this.#database
      .prepare(`
SELECT task_id, schema_version, session_id, parent_task_id, actor_id, title, created_at,
       create_record_hash
FROM tasks WHERE task_id = ?`)
      .get(taskId);
    return row ? verifyStoredTaskRecord(row) : null;
  }
}

function verifyStoredTaskRecord(row: Readonly<Record<string, unknown>>): TaskRecord {
  const record = toTaskRecord(row);
  const storedHash = readString(row.create_record_hash, "create_record_hash");
  if (storedHash !== sha256(canonicalJson(record))) {
    throw storageError(
      "storage_corrupt",
      `Task ${record.taskId} creation hash disagrees with its durable record.`,
      false,
      "Stop writes and inspect or restore the Task record.",
    );
  }
  return record;
}

function toTaskRecord(row: Readonly<Record<string, unknown>>): TaskRecord {
  return taskRecordSchema.parse({
    schemaVersion: readInteger(row.schema_version, "schema_version"),
    taskId: stableIdSchema.parse(row.task_id),
    sessionId: stableIdSchema.parse(row.session_id),
    parentTaskId: row.parent_task_id === null ? null : stableIdSchema.parse(row.parent_task_id),
    actorId: readString(row.actor_id, "actor_id"),
    title: readString(row.title, "title"),
    createdAt: utcTimestampSchema.parse(row.created_at),
  });
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw storageError(
      "storage_corrupt",
      `Stored Task ${label} is invalid.`,
      false,
      "Stop writes and inspect or restore the database.",
    );
  }
  return value;
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw storageError(
      "storage_corrupt",
      `Stored Task ${label} is invalid.`,
      false,
      "Stop writes and inspect or restore the database.",
    );
  }
  return value;
}

function taskConflict(category: string, message: string) {
  return storageError(
    category,
    message,
    false,
    "Use a new stable Task ID or inspect the existing Task record.",
  );
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
