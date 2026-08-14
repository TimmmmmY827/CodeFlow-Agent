import type { SessionLifecycle } from "../events/state-reducer.js";
import {
  StateReducer,
  checkTraceIntegrity,
} from "../events/state-reducer.js";
import type { AgentEvent } from "../events/agent-event.js";
import {
  artifactReferenceSchema,
  stableIdSchema,
  structuredErrorSchema,
  utcTimestampSchema,
  type ArtifactReference,
  type StableId,
  type StructuredError,
  type UtcTimestamp,
} from "../shared/contracts.js";
import { STORAGE_RECORD_SCHEMA_VERSION } from "./contracts.js";
import type { SqliteStorageDatabase } from "./sqlite/sqlite-database.js";
import {
  decodeAgentEvent,
  type StoredAgentEventRow,
} from "./sqlite/sqlite-event-codec.js";
import { StorageError, storageError, translateStorageError } from "./sqlite/sqlite-errors.js";

const EXTERNAL_OPERATION_UNAVAILABLE_REASON =
  "C08/C11 durable operation journals are not available in C02 storage schema v1; " +
  "event text is not authoritative external-operation state.";

export type ArtifactPhysicalState = "ready" | "missing" | "corrupt";

/**
 * Narrow read-only port. Implementations must enforce their configured Artifact
 * root and compare both byte length and SHA-256 without trusting the caller path.
 */
export interface ArtifactRecoveryVerifier {
  inspect(
    sessionId: StableId,
    reference: ArtifactReference,
  ): Promise<ArtifactPhysicalState>;
}

export interface RecoveryArtifactIssue {
  readonly reference: ArtifactReference;
  readonly reason:
    | "file_missing"
    | "hash_mismatch"
    | "metadata_marked_corrupt"
    | "commit_incomplete"
    | "deletion_incomplete";
}

export interface RecoveryDeletionStatus {
  readonly sessionDeletionState: "active" | "deleting";
  readonly receiptId: StableId | null;
  readonly receiptStatus: "none" | "missing" | "in_progress" | "complete" | "failed";
  readonly pendingItems: number;
  readonly failedItems: number;
  readonly errors: readonly StructuredError[];
}

export interface PendingPhysicalPurge {
  readonly receiptId: StableId;
  readonly completedAt: UtcTimestamp;
  readonly error: StructuredError | null;
}

export interface StorageRecoveryReport {
  readonly schemaVersion: typeof STORAGE_RECORD_SCHEMA_VERSION;
  readonly sessionId: StableId;
  /** Last lifecycle that can be derived from one contiguous valid event prefix. */
  readonly lifecycle: SessionLifecycle | null;
  /** Durable Session watermark, not the number of successfully decoded events. */
  readonly lastSequence: number;
  readonly lastStableSequence: number | null;
  readonly traceComplete: boolean;
  readonly firstGap: number | null;
  readonly traceError: StructuredError | null;
  readonly missingArtifacts: readonly RecoveryArtifactIssue[];
  readonly corruptArtifacts: readonly RecoveryArtifactIssue[];
  readonly unreadyArtifacts: readonly RecoveryArtifactIssue[];
  readonly deletion: RecoveryDeletionStatus;
  readonly pendingPhysicalPurges: readonly PendingPhysicalPurge[];
  readonly externalOperations: {
    readonly capability: "unavailable";
    readonly operations: readonly [];
    readonly reason: string;
  };
}

export class StorageRecoveryInspector {
  readonly #storage: SqliteStorageDatabase;
  readonly #artifactVerifier: ArtifactRecoveryVerifier;

  constructor(storage: SqliteStorageDatabase, artifactVerifier: ArtifactRecoveryVerifier) {
    this.#storage = storage;
    this.#artifactVerifier = artifactVerifier;
  }

  async inspect(sessionId: StableId): Promise<StorageRecoveryReport> {
    const checkedSessionId = stableIdSchema.parse(sessionId);
    try {
      const session = this.#readSession(checkedSessionId);
      const trace = this.#inspectTrace(checkedSessionId, session.lastSequence);
      const artifacts = await this.#inspectArtifacts(checkedSessionId);
      return {
        schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
        sessionId: checkedSessionId,
        lifecycle: trace.lifecycle,
        lastSequence: session.lastSequence,
        lastStableSequence: trace.lastStableSequence,
        traceComplete: trace.complete,
        firstGap: trace.firstGap,
        traceError: trace.error,
        missingArtifacts: artifacts.missing,
        corruptArtifacts: artifacts.corrupt,
        unreadyArtifacts: artifacts.unready,
        deletion: this.#inspectDeletion(checkedSessionId, session.deletionState),
        pendingPhysicalPurges: this.inspectPendingPhysicalPurges(),
        externalOperations: {
          capability: "unavailable",
          operations: [],
          reason: EXTERNAL_OPERATION_UNAVAILABLE_REASON,
        },
      };
    } catch (error: unknown) {
      if (error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }
  }

  inspectPendingPhysicalPurges(): readonly PendingPhysicalPurge[] {
    try {
      return this.#storage.database
        .prepare(`
SELECT receipt_id, completed_at, purge_error_json
FROM deleted_session_tombstones
WHERE purge_state = 'pending'
ORDER BY completed_at, receipt_id`)
        .all()
        .map((row) => ({
          receiptId: stableIdSchema.parse(row.receipt_id),
          completedAt: utcTimestampSchema.parse(row.completed_at),
          error: parseStoredError(row.purge_error_json, "tombstone purge_error_json"),
        }));
    } catch (error: unknown) {
      if (error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }
  }

  #readSession(sessionId: StableId): {
    readonly lastSequence: number;
    readonly deletionState: "active" | "deleting";
  } {
    const row = this.#storage.database
      .prepare("SELECT last_sequence, deletion_state FROM sessions WHERE session_id = ?")
      .get(sessionId);
    if (!row) {
      throw storageError(
        "session_not_found",
        `Session ${sessionId} does not exist.`,
        false,
        "Inspect a live Session or use the retained deletion tombstone service.",
      );
    }
    const lastSequence = readInteger(row.last_sequence, "sessions.last_sequence");
    if (row.deletion_state !== "active" && row.deletion_state !== "deleting") {
      throw corruptStorage("Session deletion_state is invalid.");
    }
    return { lastSequence, deletionState: row.deletion_state };
  }

  #inspectTrace(sessionId: StableId, lastSequence: number): {
    readonly lifecycle: SessionLifecycle | null;
    readonly lastStableSequence: number | null;
    readonly complete: boolean;
    readonly firstGap: number | null;
    readonly error: StructuredError | null;
  } {
    const rows = this.#storage.database
      .prepare(`${EVENT_COLUMNS} WHERE session_id = ? ORDER BY sequence`)
      .all(sessionId);
    const events: AgentEvent[] = [];
    let decodeError: StructuredError | null = null;
    let firstUndecodableSequence: number | null = null;
    for (const row of rows) {
      try {
        events.push(decodeAgentEvent(row as unknown as StoredAgentEventRow));
      } catch (error: unknown) {
        decodeError ??= errorDetails(error);
        if (firstUndecodableSequence === null) {
          firstUndecodableSequence = readNonnegativeIntegerOrNull(row.sequence);
        }
      }
    }

    const integrity = checkTraceIntegrity(events);
    const prefixProjection = projectContiguousPrefix(events);
    const highestDecodedSequence = events.at(-1)?.sequence ?? -1;
    const watermarkMatches = highestDecodedSequence === lastSequence;
    let firstGap = integrity.firstGap;
    if (firstGap === null && firstUndecodableSequence !== null) {
      firstGap = firstUndecodableSequence;
    }
    if (firstGap === null && highestDecodedSequence < lastSequence) {
      firstGap = highestDecodedSequence + 1;
    }

    const complete = decodeError === null && integrity.complete && watermarkMatches &&
      lastSequence >= 0 && prefixProjection.lifecycle !== null;
    let error = decodeError ?? integrity.firstError;
    if (error === null && !watermarkMatches) {
      error = storageDetails(
        "storage_corrupt",
        `Session watermark ${lastSequence} disagrees with highest decoded event sequence ${highestDecodedSequence}.`,
        "Stop writes and restore or inspect the affected Session facts.",
      );
    }
    if (error === null && !complete) {
      error = storageDetails(
        "trace_incomplete",
        "Session has no complete reducible event trace.",
        "Restore the missing facts before resuming the Session.",
      );
    }

    return {
      lifecycle: prefixProjection.lifecycle,
      lastStableSequence: prefixProjection.lastStableSequence,
      complete,
      firstGap,
      error,
    };
  }

  async #inspectArtifacts(sessionId: StableId): Promise<{
    readonly missing: RecoveryArtifactIssue[];
    readonly corrupt: RecoveryArtifactIssue[];
    readonly unready: RecoveryArtifactIssue[];
  }> {
    const rows = this.#storage.database
      .prepare(`
SELECT artifact_id, ready_relative_path, media_type, byte_length, sha256, sensitivity, state
FROM artifacts WHERE session_id = ? ORDER BY artifact_id`)
      .all(sessionId);
    const missing: RecoveryArtifactIssue[] = [];
    const corrupt: RecoveryArtifactIssue[] = [];
    const unready: RecoveryArtifactIssue[] = [];

    for (const row of rows) {
      const reference = parseArtifactReference(row);
      if (row.state === "corrupt") {
        corrupt.push({ reference, reason: "metadata_marked_corrupt" });
        continue;
      }
      if (row.state === "staged") {
        unready.push({ reference, reason: "commit_incomplete" });
        continue;
      }
      if (row.state === "deleting") {
        unready.push({ reference, reason: "deletion_incomplete" });
        continue;
      }
      if (row.state !== "ready") throw corruptStorage("Artifact state is invalid.");

      const physicalState = await this.#artifactVerifier.inspect(sessionId, reference);
      if (physicalState === "missing") {
        missing.push({ reference, reason: "file_missing" });
      } else if (physicalState === "corrupt") {
        corrupt.push({ reference, reason: "hash_mismatch" });
      } else if (physicalState !== "ready") {
        throw corruptStorage("Artifact verifier returned an invalid physical state.");
      }
    }
    return { missing, corrupt, unready };
  }

  #inspectDeletion(
    sessionId: StableId,
    sessionDeletionState: "active" | "deleting",
  ): RecoveryDeletionStatus {
    const row = this.#storage.database
      .prepare(`
SELECT receipt_id, status, error_json FROM delete_receipts
WHERE session_id = ?
  AND EXISTS (
    SELECT 1 FROM delete_receipt_items
    WHERE delete_receipt_items.receipt_id = delete_receipts.receipt_id
      AND delete_receipt_items.target = 'session'
  )
ORDER BY started_at DESC, receipt_id DESC LIMIT 1`)
      .get(sessionId);
    if (!row) {
      return {
        sessionDeletionState,
        receiptId: null,
        receiptStatus: sessionDeletionState === "deleting" ? "missing" : "none",
        pendingItems: 0,
        failedItems: 0,
        errors: [],
      };
    }
    if (typeof row.receipt_id !== "string" ||
        (row.status !== "in_progress" && row.status !== "complete" && row.status !== "failed")) {
      throw corruptStorage("Delete receipt identity or status is invalid.");
    }
    const itemRows = this.#storage.database
      .prepare(`
SELECT status, error_json
FROM delete_receipt_items WHERE receipt_id = ?`)
      .all(row.receipt_id);
    let pendingItems = 0;
    let failedItems = 0;
    const errors: StructuredError[] = [];
    const receiptError = parseStoredError(row.error_json, "delete receipt error_json");
    if (receiptError !== null) appendUniqueError(errors, receiptError);
    for (const item of itemRows) {
      if (item.status === "pending") pendingItems += 1;
      if (item.status === "failed") failedItems += 1;
      const error = parseStoredError(item.error_json, "delete item error_json");
      if (error !== null) appendUniqueError(errors, error);
    }
    return {
      sessionDeletionState,
      receiptId: stableIdSchema.parse(row.receipt_id),
      receiptStatus: row.status,
      pendingItems,
      failedItems,
      errors,
    };
  }
}

const EVENT_COLUMNS = `SELECT event_id, session_id, task_id, sequence, event_type,
  schema_version, occurred_at, trace_id, span_id, parent_span_id, event_hash, event_json
  FROM agent_events`;

function projectContiguousPrefix(events: readonly AgentEvent[]): {
  readonly lifecycle: SessionLifecycle | null;
  readonly lastStableSequence: number | null;
} {
  const reducer = new StateReducer();
  let expectedSequence = 0;
  for (const event of events) {
    if (event.sequence !== expectedSequence) break;
    try {
      reducer.apply(event);
    } catch {
      break;
    }
    expectedSequence += 1;
  }
  const snapshot = reducer.snapshot();
  return {
    lifecycle: snapshot?.status ?? null,
    lastStableSequence: snapshot?.lastSequence ?? null,
  };
}

function parseArtifactReference(row: Record<string, unknown>): ArtifactReference {
  const parsed = artifactReferenceSchema.safeParse({
    artifactId: row.artifact_id,
    relativePath: row.ready_relative_path,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    sensitivity: row.sensitivity,
  });
  if (!parsed.success) {
    throw corruptStorage(`Artifact metadata is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw corruptStorage(`${label} is not a safe integer.`);
  }
  return value;
}

function readNonnegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorDetails(error: unknown): StructuredError {
  if (error instanceof StorageError) return error.details;
  return translateStorageError(error).details;
}

function corruptStorage(message: string): StorageError {
  return storageError(
    "storage_corrupt",
    message,
    false,
    "Stop writes and inspect the storage database.",
  );
}

function storageDetails(category: string, message: string, recovery: string): StructuredError {
  return {
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  };
}

function parseStoredError(value: unknown, label: string): StructuredError | null {
  if (value === null) return null;
  if (typeof value !== "string") throw corruptStorage(`${label} is not JSON text.`);
  try {
    const parsed = structuredErrorSchema.safeParse(JSON.parse(value));
    if (!parsed.success) throw corruptStorage(`${label} is not a StructuredError.`);
    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof StorageError) throw error;
    throw corruptStorage(`${label} is invalid JSON.`);
  }
}

function appendUniqueError(errors: StructuredError[], candidate: StructuredError): void {
  if (errors.some((error) =>
    error.category === candidate.category &&
    error.message === candidate.message &&
    error.sideEffectStatus === candidate.sideEffectStatus)) return;
  errors.push(candidate);
}
