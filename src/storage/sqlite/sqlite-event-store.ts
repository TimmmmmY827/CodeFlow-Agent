import type { DatabaseSync } from "node:sqlite";

import { parseAgentEvent, type AgentEvent } from "../../events/agent-event.js";
import {
  EventStoreError,
  type EventAppendResult,
  type EventListener,
  type EventStore,
  type EventSubscriber,
  validateEventCursor,
  validateEventListener,
  validateEventSessionId,
} from "../../events/event-store.js";
import type { StableId, StructuredError } from "../../shared/contracts.js";
import type { SqliteStorageDatabase } from "./sqlite-database.js";
import {
  decodeAgentEvent,
  encodeAgentEvent,
  type StoredAgentEventRow,
} from "./sqlite-event-codec.js";
import { StorageError, storageError, translateStorageError } from "./sqlite-errors.js";

export interface SqliteEventStoreOptions {
  /** Transaction fault hooks must throw synchronously; async hooks could let
   * another operation re-enter this DatabaseSync transaction. */
  readonly faultInjector?: {
    hit(point: "event_after_insert"): void;
  };
}

export class SqliteEventStore implements EventStore, EventSubscriber {
  readonly #storage: SqliteStorageDatabase;
  readonly #faultInjector: SqliteEventStoreOptions["faultInjector"] | null;
  readonly #listeners = new Map<StableId, Set<EventListener>>();

  constructor(storage: SqliteStorageDatabase, options: SqliteEventStoreOptions = {}) {
    this.#storage = storage;
    this.#faultInjector = options.faultInjector ?? null;
  }

  async append(event: AgentEvent): Promise<EventAppendResult> {
    const parsed = parseAgentEvent(event);
    if (!parsed.ok) throw new EventStoreError(parsed.error);
    const fact = parsed.value;
    const encoded = encodeAgentEvent(fact);
    const database = this.#storage.database;

    try {
      database.exec("BEGIN IMMEDIATE");
      const existingById = database
        .prepare(`${EVENT_COLUMNS} WHERE event_id = ?`)
        .get(fact.eventId);
      if (existingById) {
        const storedFact = decodeAgentEvent(existingById as unknown as StoredAgentEventRow);
        const storedEncoding = encodeAgentEvent(storedFact);
        if (storedEncoding.json === encoded.json && storedEncoding.hash === encoded.hash) {
          validateWatermark(database, fact.sessionId);
          database.exec("COMMIT");
          return "duplicate";
        }
        throw eventStoreError(
          "event_id_conflict",
          `Event ID ${fact.eventId} already exists with different contents.`,
          "Stop the session and inspect the conflicting trace before retrying.",
        );
      }

      const occupiedSequence = database
        .prepare("SELECT event_id FROM agent_events WHERE session_id = ? AND sequence = ?")
        .get(fact.sessionId, fact.sequence);
      if (occupiedSequence) {
        throw eventStoreError(
          "event_sequence_conflict",
          `Event sequence ${fact.sequence} is already occupied in Session ${fact.sessionId}.`,
          "Reload the Session facts and allocate a sequence greater than the current watermark.",
        );
      }

      const session = database
        .prepare("SELECT last_sequence, deletion_state FROM sessions WHERE session_id = ?")
        .get(fact.sessionId);
      if (!session) {
        throw storageError(
          "session_not_found",
          `Session ${fact.sessionId} does not exist.`,
          false,
          "Create the Session, root Task, and session.created fact atomically first.",
        );
      }
      if (session.deletion_state !== "active") {
        throw storageError(
          "session_deleting",
          `Session ${fact.sessionId} is being deleted.`,
          false,
          "Do not append new facts after Session deletion begins.",
        );
      }
      const previousSequence = readInteger(session.last_sequence, "last_sequence");
      if (fact.sequence <= previousSequence) {
        throw eventStoreError(
          "event_sequence_conflict",
          `Event sequence ${fact.sequence} is not greater than ${previousSequence}.`,
          "Reload the Session sequence and append a new fact above the persisted watermark.",
        );
      }

      const task = database
        .prepare("SELECT session_id FROM tasks WHERE task_id = ?")
        .get(fact.taskId);
      if (!task || task.session_id !== fact.sessionId) {
        throw storageError(
          "task_not_found",
          `Task ${fact.taskId} does not belong to Session ${fact.sessionId}.`,
          false,
          "Persist the Task metadata before appending facts that reference it.",
        );
      }

      insertEvent(database, fact, encoded.json, encoded.hash);
      this.#faultInjector?.hit("event_after_insert");

      const update = database
        .prepare(
          `UPDATE sessions
             SET last_sequence = ?, updated_at = ?
           WHERE session_id = ? AND last_sequence = ? AND deletion_state = 'active'`,
        )
        .run(fact.sequence, this.#storage.clock.utcNow(), fact.sessionId, previousSequence);
      if (update.changes !== 1) {
        throw eventStoreError(
          "event_sequence_conflict",
          `Session ${fact.sessionId} sequence watermark changed during append.`,
          "Reload the Session sequence and retry with a fresh event identity.",
        );
      }
      database.exec("COMMIT");
    } catch (error: unknown) {
      rollback(database);
      if (error instanceof EventStoreError || error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }

    await this.#notify(fact.sessionId, fact);
    return "inserted";
  }

  async list(sessionId: StableId, afterSequence?: number): Promise<readonly AgentEvent[]> {
    const checkedSessionId = validateEventSessionId(sessionId);
    validateEventCursor(afterSequence);
    try {
      const rows = afterSequence === undefined
        ? this.#storage.database
            .prepare(`${EVENT_COLUMNS} WHERE session_id = ? ORDER BY sequence`)
            .all(checkedSessionId)
        : this.#storage.database
            .prepare(`${EVENT_COLUMNS} WHERE session_id = ? AND sequence > ? ORDER BY sequence`)
            .all(checkedSessionId, afterSequence);
      return rows.map((row) => decodeAgentEvent(row as unknown as StoredAgentEventRow));
    } catch (error: unknown) {
      if (error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }
  }

  async latestSequence(sessionId: StableId): Promise<number | null> {
    const checkedSessionId = validateEventSessionId(sessionId);
    try {
      const row = this.#storage.database
        .prepare("SELECT MAX(sequence) AS latest_sequence FROM agent_events WHERE session_id = ?")
        .get(checkedSessionId);
      const value = row?.latest_sequence;
      if (value === null || value === undefined) return null;
      return readInteger(value, "latest_sequence");
    } catch (error: unknown) {
      if (error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }
  }

  subscribe(sessionId: StableId, listener: EventListener): () => void {
    const checkedSessionId = validateEventSessionId(sessionId);
    validateEventListener(listener);
    const listeners = this.#listeners.get(checkedSessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(checkedSessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(checkedSessionId);
    };
  }

  async #notify(sessionId: StableId, event: AgentEvent): Promise<void> {
    const listeners = [...(this.#listeners.get(sessionId) ?? [])];
    await Promise.allSettled(
      listeners.map(async (listener) => listener(structuredClone(event))),
    );
  }
}


const EVENT_COLUMNS = `SELECT event_id, session_id, task_id, sequence, event_type,
  schema_version, occurred_at, trace_id, span_id, parent_span_id, event_hash, event_json
  FROM agent_events`;

export function insertEvent(
  database: DatabaseSync,
  event: AgentEvent,
  json: string,
  hash: string,
): void {
  database
    .prepare(
      `INSERT INTO agent_events(
        event_id, session_id, task_id, sequence, event_type, schema_version,
        occurred_at, trace_id, span_id, parent_span_id, event_hash, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
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
      hash,
      json,
    );
}

function rollback(database: DatabaseSync): void {
  if (database.isTransaction) database.exec("ROLLBACK");
}

function readInteger(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw storageError(
      "storage_corrupt",
      `Storage column ${column} is not a safe integer.`,
      false,
      "Stop writes and inspect the database.",
    );
  }
  return value;
}

function validateWatermark(database: DatabaseSync, sessionId: StableId): void {
  const session = database
    .prepare("SELECT last_sequence FROM sessions WHERE session_id = ?")
    .get(sessionId);
  const latest = database
    .prepare("SELECT MAX(sequence) AS latest_sequence FROM agent_events WHERE session_id = ?")
    .get(sessionId)?.latest_sequence;
  if (!session || latest === null || latest === undefined) {
    throw storageError(
      "storage_corrupt",
      `Event facts for Session ${sessionId} have lost their Session watermark.`,
      false,
      "Stop writes and inspect the affected Session metadata.",
    );
  }
  if (readInteger(session.last_sequence, "last_sequence") !== readInteger(latest, "latest_sequence")) {
    throw storageError(
      "storage_corrupt",
      `Session ${sessionId} watermark disagrees with its latest durable event.`,
      false,
      "Stop writes and rebuild the Session metadata from verified facts.",
    );
  }
}

function eventStoreError(
  category: "event_id_conflict" | "event_sequence_conflict",
  message: string,
  recovery: string,
): EventStoreError {
  const details: StructuredError = {
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  };
  return new EventStoreError(details);
}
