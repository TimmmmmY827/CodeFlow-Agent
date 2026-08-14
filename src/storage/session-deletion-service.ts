import { createHash, createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createStableId,
  stableIdSchema,
  structuredErrorSchema,
  utcTimestampSchema,
  type StableId,
  type StructuredError,
} from "../shared/contracts.js";
import { canonicalJson } from "../shared/json.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type DeleteReceipt,
  type DeleteReceiptItem,
  type DeleteTarget,
  type DeletedSessionIdentity,
  type SessionDeletionCoordinator,
} from "./contracts.js";
import { SqliteStorageDatabase } from "./sqlite/sqlite-database.js";
import { StorageError, storageError, translateStorageError } from "./sqlite/sqlite-errors.js";

export interface ArtifactFileDeleteRequest {
  readonly sessionId: StableId;
  readonly artifactId: StableId;
  readonly relativePath: string;
}

/** A narrow port whose implementation must enforce its configured Artifact root. */
export interface ArtifactFileDeleter {
  deleteArtifactFile(
    request: ArtifactFileDeleteRequest,
  ): Promise<"deleted" | "missing">;
  finalizeSessionDirectory(sessionId: StableId): Promise<"deleted" | "missing">;
}

export interface SessionDeletionServiceOptions {
  readonly artifactFileDeleter: ArtifactFileDeleter;
  /** Install-local secret used to make retained reference hashes irreversible. */
  readonly referenceHashKey: string | Uint8Array;
  readonly faultInjector?: {
    hit(
      point: "delete_after_receipt" | "delete_after_artifact_files" | "delete_before_final_commit",
    ): void | Promise<void>;
  };
}

interface ArtifactPath {
  readonly artifactId: StableId;
  readonly relativePath: string;
  readonly referenceHash: string;
}

interface ArtifactMetadata {
  readonly artifactId: StableId;
  readonly referenceHash: string;
}

interface IdentifiedRecord {
  readonly id: string;
  readonly referenceHash: string;
}

interface DeletionSnapshot {
  readonly artifactPaths: readonly ArtifactPath[];
  readonly artifacts: readonly ArtifactMetadata[];
  readonly events: readonly IdentifiedRecord[];
  readonly approvals: readonly IdentifiedRecord[];
  readonly usage: readonly IdentifiedRecord[];
  readonly taskCount: number;
  readonly workspaceId: StableId;
  readonly sessionReferenceHash: string;
}

interface ReceiptLookup {
  readonly receiptId: StableId;
  readonly status: DeleteReceipt["status"];
}

interface TombstoneLookup {
  readonly receipt: DeleteReceipt;
  readonly purgeState: "pending" | "complete";
}

type BeginDeletionResult =
  | { readonly status: "work"; readonly lookup: ReceiptLookup; readonly created: boolean }
  | { readonly status: "complete"; readonly receipt: DeleteReceipt };

type ResumeDeletionResult =
  | { readonly status: "work"; readonly lookup: ReceiptLookup }
  | { readonly status: "complete"; readonly receipt: DeleteReceipt };

type PreparedAttempt =
  | { readonly status: "ready"; readonly snapshot: DeletionSnapshot }
  | { readonly status: "complete"; readonly receipt: DeleteReceipt };

type FinalizeOutcome =
  | { readonly status: "complete"; readonly receipt: DeleteReceipt }
  | { readonly status: "purge_pending"; readonly receipt: DeleteReceipt }
  | { readonly status: "needs_files" }
  | { readonly status: "failed"; readonly receipt: DeleteReceipt };

/**
 * Coordinates Session erasure without treating file deletion and SQLite as one
 * fictitious transaction. Durable pending items are written first; retries then
 * reconcile idempotent file results before the final metadata transaction.
 */
export class SessionDeletionService implements SessionDeletionCoordinator, DeletedSessionIdentity {
  readonly #storage: SqliteStorageDatabase;
  readonly #database: DatabaseSync;
  readonly #artifactFileDeleter: ArtifactFileDeleter;
  readonly #referenceHashKey: Uint8Array;
  readonly #referenceHashKeyId: string;
  readonly #faultInjector: SessionDeletionServiceOptions["faultInjector"] | null;
  readonly #inFlight = new Map<StableId, Promise<DeleteReceipt>>();

  constructor(storage: SqliteStorageDatabase, options: SessionDeletionServiceOptions) {
    if (typeof options.referenceHashKey === "string" && options.referenceHashKey.length === 0) {
      throw new RangeError("referenceHashKey must not be empty.");
    }
    if (options.referenceHashKey instanceof Uint8Array && options.referenceHashKey.byteLength === 0) {
      throw new RangeError("referenceHashKey must not be empty.");
    }
    this.#storage = storage;
    this.#database = storage.database;
    this.#artifactFileDeleter = options.artifactFileDeleter;
    this.#faultInjector = options.faultInjector ?? null;
    this.#referenceHashKey = typeof options.referenceHashKey === "string"
      ? new TextEncoder().encode(options.referenceHashKey)
      : new Uint8Array(options.referenceHashKey);
    this.#referenceHashKeyId = `sha256:${createHash("sha256")
      .update(this.#referenceHashKey)
      .digest("hex")}`;
    this.#bindReferenceHashKey();
  }

  hasDeletedSessionIdentity(sessionId: StableId): boolean {
    return this.#loadTombstone(stableIdSchema.parse(sessionId)) !== null;
  }

  async delete(sessionId: StableId): Promise<DeleteReceipt> {
    const checkedSessionId = stableIdSchema.parse(sessionId);
    const existing = this.#inFlight.get(checkedSessionId);
    if (existing) return existing;

    // Defer execution one microtask so the coalescing entry is visible even to
    // a synchronously re-entrant ArtifactFileDeleter implementation.
    const operation = Promise.resolve().then(() => this.#deleteOnce(checkedSessionId));
    this.#inFlight.set(checkedSessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlight.get(checkedSessionId) === operation) {
        this.#inFlight.delete(checkedSessionId);
      }
    }
  }

  async #deleteOnce(checkedSessionId: StableId): Promise<DeleteReceipt> {
    const tombstone = this.#loadTombstone(checkedSessionId);
    if (tombstone) {
      if (this.#sessionExists(checkedSessionId)) {
        throw deletionError(
          "storage_corrupt",
          `Deleted Session ${checkedSessionId} has been recreated beside its retained tombstone.`,
          "Stop writes and repair the conflicting live Session and deletion tombstone.",
        );
      }
      return this.#completePhysicalPurge(tombstone);
    }

    let lookup = this.#findReceipt(checkedSessionId);
    let created = false;
    if (!lookup) {
      const begun = this.#beginDeletion(checkedSessionId);
    if (begun.status === "complete") return this.#completePhysicalPurge(begun.receipt);
      lookup = begun.lookup;
      created = begun.created;
    }

    const racedCompletion = this.#loadTombstone(checkedSessionId);
    if (racedCompletion) return this.#completePhysicalPurge(racedCompletion);
    if (lookup.status === "complete") {
      throw deletionError(
        "deletion_receipt_corrupt",
        `Completed raw delete receipt ${lookup.receiptId} was not compacted to a tombstone.`,
        "Inspect and repair the deletion receipt before continuing.",
      );
    }
    if (!this.#sessionExists(checkedSessionId)) {
      throw deletionError(
        "deletion_state_corrupt",
        `Incomplete delete receipt ${lookup.receiptId} has lost its Session metadata.`,
        "Restore the database transaction before resuming deletion.",
      );
    }

    if (created) {
      await this.#hit("delete_after_receipt");
    } else {
      const resumed = this.#resumeReceipt(lookup.receiptId, checkedSessionId);
      if (resumed.status === "complete") return this.#completePhysicalPurge(resumed.receipt);
      lookup = resumed.lookup;
    }

    for (;;) {
      const attempt = this.#prepareAttempt(lookup.receiptId, checkedSessionId);
      if (attempt.status === "complete") return this.#completePhysicalPurge(attempt.receipt);
      const fileFailure = await this.#deleteFiles(
        lookup.receiptId,
        checkedSessionId,
        attempt.snapshot,
      );
      const completedDuringFiles = this.#loadTombstone(checkedSessionId);
      if (completedDuringFiles) return this.#completePhysicalPurge(completedDuringFiles);
      if (fileFailure || this.#hasUnresolvedFileItems(lookup.receiptId, attempt.snapshot)) {
        this.#markReceiptFailed(lookup.receiptId);
        const completedAfterFailure = this.#loadTombstone(checkedSessionId);
        return completedAfterFailure
          ? this.#completePhysicalPurge(completedAfterFailure)
          : this.#loadReceipt(lookup.receiptId);
      }

      try {
        await this.#artifactFileDeleter.finalizeSessionDirectory(checkedSessionId);
      } catch (error: unknown) {
        this.#markReceiptFailed(lookup.receiptId, errorDetails(error));
        return this.#loadReceipt(lookup.receiptId);
      }

      await this.#hit("delete_after_artifact_files");
      await this.#hit("delete_before_final_commit");

      const outcome = this.#finalizeMetadata(lookup.receiptId, checkedSessionId);
      if (outcome.status === "complete") return this.#completePhysicalPurge(outcome.receipt);
      if (outcome.status === "failed") return outcome.receipt;
      if (outcome.status === "purge_pending") return this.#completePhysicalPurge(outcome.receipt);
      // A direct writer introduced a new Artifact after the previous snapshot.
      // The Session remains deleting; persist its new item and reconcile it too.
    }
  }

  #beginDeletion(sessionId: StableId): BeginDeletionResult {
    const receiptId = createStableId();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const completed = this.#loadTombstone(sessionId);
      if (completed) {
        this.#database.exec("COMMIT");
        return { status: "complete", receipt: completed.receipt };
      }
      const existing = this.#findReceipt(sessionId);
      if (existing) {
        this.#database.exec("COMMIT");
        return { status: "work", lookup: existing, created: false };
      }
      if (!this.#sessionExists(sessionId)) throw sessionNotFound(sessionId);
      const snapshot = this.#snapshot(sessionId);
      this.#database
        .prepare(`
INSERT INTO delete_receipts(receipt_id, schema_version, session_id, status, started_at, completed_at)
VALUES (?, ?, ?, 'in_progress', ?, NULL)`)
        .run(receiptId, STORAGE_RECORD_SCHEMA_VERSION, sessionId, this.#storage.clock.utcNow());
      this.#insertMissingItems(receiptId, snapshot);
      this.#markRecordsDeleting(sessionId);
      this.#database.exec("COMMIT");
      return {
        status: "work",
        lookup: { receiptId, status: "in_progress" },
        created: true,
      };
    } catch (error: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw translateStorageError(error);
    }
  }

  #resumeReceipt(receiptId: StableId, sessionId: StableId): ResumeDeletionResult {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const completed = this.#loadTombstone(sessionId);
      if (completed) {
        this.#database.exec("COMMIT");
        return { status: "complete", receipt: completed.receipt };
      }
      const current = this.#requireCurrentReceipt(receiptId, sessionId);
      if (current.status === "complete") throw uncompactReceipt(receiptId);
      if (!this.#sessionExists(sessionId)) {
        throw deletionError(
          "deletion_state_corrupt",
          `Incomplete delete receipt ${receiptId} has lost its Session metadata.`,
          "Restore the database transaction before resuming deletion.",
        );
      }
      this.#database
        .prepare(`
UPDATE delete_receipts SET status = 'in_progress', completed_at = NULL
WHERE receipt_id = ? AND status <> 'complete'`)
        .run(receiptId);
      this.#insertMissingItems(receiptId, this.#snapshot(sessionId));
      this.#markRecordsDeleting(sessionId);
      this.#database.exec("COMMIT");
      return { status: "work", lookup: { receiptId, status: "in_progress" } };
    } catch (error: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw translateStorageError(error);
    }
  }

  #prepareAttempt(receiptId: StableId, sessionId: StableId): PreparedAttempt {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const completed = this.#loadTombstone(sessionId);
      if (completed) {
        this.#database.exec("COMMIT");
        return { status: "complete", receipt: completed.receipt };
      }
      const current = this.#requireCurrentReceipt(receiptId, sessionId);
      if (current.status === "complete") throw uncompactReceipt(receiptId);
      if (!this.#sessionExists(sessionId)) {
        throw deletionError(
          "deletion_state_corrupt",
          `Incomplete delete receipt ${receiptId} has lost its Session metadata.`,
          "Restore the database transaction before resuming deletion.",
        );
      }
      const snapshot = this.#snapshot(sessionId);
      this.#insertMissingItems(receiptId, snapshot);
      this.#markRecordsDeleting(sessionId);
      this.#database.exec("COMMIT");
      return { status: "ready", snapshot };
    } catch (error: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw translateStorageError(error);
    }
  }

  async #deleteFiles(
    receiptId: StableId,
    sessionId: StableId,
    snapshot: DeletionSnapshot,
  ): Promise<boolean> {
    let failed = false;
    for (const file of snapshot.artifactPaths) {
      if (this.#loadTombstone(sessionId)) return false;
      const status = this.#itemStatus(receiptId, file.referenceHash, sessionId);
      if (status === "compacted") return false;
      if (status === "deleted" || status === "missing") continue;
      this.#updateItem(receiptId, file.referenceHash, "pending", null);
      try {
        const result = await this.#artifactFileDeleter.deleteArtifactFile({
          sessionId,
          artifactId: file.artifactId,
          relativePath: file.relativePath,
        });
        if (result !== "deleted" && result !== "missing") {
          throw new TypeError("ArtifactFileDeleter returned an invalid status.");
        }
        this.#updateItem(receiptId, file.referenceHash, result, null);
      } catch (error: unknown) {
        failed = true;
        this.#updateItem(receiptId, file.referenceHash, "failed", errorDetails(error));
      }
    }
    return failed;
  }

  #hasUnresolvedFileItems(receiptId: StableId, snapshot: DeletionSnapshot): boolean {
    const current = new Set(snapshot.artifactPaths.map((file) => file.referenceHash));
    let unresolved = false;
    const rows = this.#database
      .prepare(`
SELECT reference_hash, status FROM delete_receipt_items
WHERE receipt_id = ? AND target = 'artifact_file'`)
      .all(receiptId);
    for (const row of rows) {
      const referenceHash = readString(row.reference_hash, "delete item reference_hash");
      const status = readItemStatus(row.status);
      if (status === "deleted" || status === "missing") continue;
      unresolved = true;
      if (!current.has(referenceHash)) {
        this.#updateItem(receiptId, referenceHash, "failed", {
          category: "deletion_reference_lost",
          message: "Artifact metadata was lost before its file deletion could be reconciled.",
          retryable: false,
          sideEffectStatus: "unknown",
          recovery: "Restore the Artifact metadata before resuming Session deletion.",
        });
      }
    }
    return unresolved;
  }

  #finalizeMetadata(
    receiptId: StableId,
    sessionId: StableId,
  ): FinalizeOutcome {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const completed = this.#loadTombstone(sessionId);
      if (completed) {
        this.#database.exec("COMMIT");
        return { status: "complete", receipt: completed.receipt };
      }
      const current = this.#requireCurrentReceipt(receiptId, sessionId);
      if (current.status === "complete") throw uncompactReceipt(receiptId);
      if (!this.#sessionExists(sessionId)) {
        throw deletionError(
          "deletion_state_corrupt",
          `Incomplete delete receipt ${receiptId} has lost its Session metadata.`,
          "Restore the database transaction before resuming deletion.",
        );
      }
      const snapshot = this.#snapshot(sessionId);
      this.#insertMissingItems(receiptId, snapshot);
      if (snapshot.artifactPaths.some((file) => {
        const status = this.#itemStatus(receiptId, file.referenceHash, sessionId);
        if (status === "compacted") return false;
        return status !== "deleted" && status !== "missing";
      })) {
        this.#database.exec("COMMIT");
        return { status: "needs_files" };
      }

      this.#database
        .prepare(`
UPDATE delete_receipt_items SET status = 'missing', error_json = NULL
WHERE receipt_id = ? AND target IN ('event', 'approval', 'usage', 'artifact_metadata', 'session')`)
        .run(receiptId);
      this.#deleteIdentifiedRows(receiptId, "agent_events", "event_id", "event", snapshot.events);
      this.#database.prepare("DELETE FROM tasks WHERE session_id = ?").run(sessionId);
      this.#deleteIdentifiedRows(receiptId, "approvals", "approval_id", "approval", snapshot.approvals);
      this.#deleteIdentifiedRows(receiptId, "usage_entries", "usage_id", "usage", snapshot.usage);
      this.#deleteIdentifiedRows(
        receiptId,
        "artifacts",
        "artifact_id",
        "artifact_metadata",
        snapshot.artifacts.map((artifact) => ({
          id: artifact.artifactId,
          referenceHash: artifact.referenceHash,
        })),
      );
      const sessionResult = this.#database
        .prepare("DELETE FROM sessions WHERE session_id = ?")
        .run(sessionId);
      this.#updateItem(
        receiptId,
        snapshot.sessionReferenceHash,
        sessionResult.changes === 0 ? "missing" : "deleted",
        null,
      );

      const completedAt = this.#storage.clock.utcNow();
      const items = this.#loadItems(receiptId);
      const receiptRow = this.#database
        .prepare("SELECT schema_version, started_at FROM delete_receipts WHERE receipt_id = ?")
        .get(receiptId);
      if (!receiptRow) throw uncompactReceipt(receiptId);
      const completeReceipt: DeleteReceipt = {
        schemaVersion: readStorageSchemaVersion(receiptRow.schema_version),
        receiptId,
        sessionId,
        status: "complete",
        startedAt: utcTimestampSchema.parse(receiptRow.started_at),
        completedAt,
        items,
      };
      const targetCounts = countTargets(items, snapshot.taskCount);
      this.#database
        .prepare(`
INSERT INTO deleted_session_tombstones(
  receipt_id, schema_version, session_id_hash, requested_at,
  completed_at, final_status, target_counts_json, purge_state, purge_error_json
)
SELECT receipt_id, schema_version, ?, started_at, ?, 'complete', ?, 'pending', NULL
FROM delete_receipts WHERE receipt_id = ?`)
        .run(
          this.#referenceHash("session", sessionId),
          completedAt,
          canonicalJson(targetCounts),
          receiptId,
        );
      this.#database
        .prepare("DELETE FROM delete_receipts WHERE receipt_id = ?")
        .run(receiptId);
      this.#database
        .prepare(`
DELETE FROM workspaces
WHERE workspace_id = ?
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = ?)`)
        .run(snapshot.workspaceId, snapshot.workspaceId);
      this.#database.exec("COMMIT");
      return { status: "purge_pending", receipt: completeReceipt };
    } catch (error: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      const completed = this.#loadTombstone(sessionId);
      if (completed) return { status: "complete", receipt: completed.receipt };
      try {
        this.#markReceiptFailed(receiptId, errorDetails(error));
      } catch {
        throw translateStorageError(error);
      }
      return { status: "failed", receipt: this.#loadReceipt(receiptId) };
    }
  }

  #deleteIdentifiedRows(
    receiptId: StableId,
    table: "agent_events" | "approvals" | "usage_entries" | "artifacts",
    idColumn: "event_id" | "approval_id" | "usage_id" | "artifact_id",
    target: "event" | "approval" | "usage" | "artifact_metadata",
    records: readonly IdentifiedRecord[],
  ): void {
    const statement = this.#database.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`);
    for (const record of records) {
      const result = statement.run(record.id);
      this.#updateItem(
        receiptId,
        record.referenceHash,
        result.changes === 0 ? "missing" : "deleted",
        null,
      );
    }
    void target;
  }

  #snapshot(sessionId: StableId): DeletionSnapshot {
    const session = this.#database
      .prepare("SELECT workspace_id FROM sessions WHERE session_id = ?")
      .get(sessionId);
    if (!session) throw sessionNotFound(sessionId);
    const artifactRows = this.#database
      .prepare(`
SELECT artifact_id, staged_relative_path, ready_relative_path
FROM artifacts WHERE session_id = ? ORDER BY artifact_id`)
      .all(sessionId);
    const artifactPaths: ArtifactPath[] = [];
    const artifacts: ArtifactMetadata[] = [];
    for (const row of artifactRows) {
      const artifactId = stableIdSchema.parse(row.artifact_id);
      const paths = new Set<string>();
      if (row.staged_relative_path !== null) {
        paths.add(readString(row.staged_relative_path, "staged Artifact path"));
      }
      paths.add(readString(row.ready_relative_path, "ready Artifact path"));
      for (const relativePath of paths) {
        artifactPaths.push({
          artifactId,
          relativePath,
          referenceHash: this.#referenceHash(
            "artifact_file",
            `${artifactId}\0${relativePath}`,
          ),
        });
      }
      artifacts.push({
        artifactId,
        referenceHash: this.#referenceHash("artifact_metadata", artifactId),
      });
    }
    return {
      artifactPaths,
      artifacts,
      events: this.#identifiedRecords(sessionId, "agent_events", "event_id", "event"),
      approvals: this.#identifiedRecords(sessionId, "approvals", "approval_id", "approval"),
      usage: this.#identifiedRecords(sessionId, "usage_entries", "usage_id", "usage"),
      taskCount: readCount(
        this.#database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE session_id = ?").get(sessionId),
      ),
      workspaceId: stableIdSchema.parse(session.workspace_id),
      sessionReferenceHash: this.#referenceHash("session", sessionId),
    };
  }

  #identifiedRecords(
    sessionId: StableId,
    table: "agent_events" | "approvals" | "usage_entries",
    idColumn: "event_id" | "approval_id" | "usage_id",
    target: "event" | "approval" | "usage",
  ): IdentifiedRecord[] {
    return this.#database
      .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE session_id = ? ORDER BY ${idColumn}`)
      .all(sessionId)
      .map((row) => {
        const id = readString(row.id, `${target} ID`);
        return { id, referenceHash: this.#referenceHash(target, id) };
      });
  }

  #insertMissingItems(receiptId: StableId, snapshot: DeletionSnapshot): void {
    const items: Array<{ target: DeleteTarget; referenceHash: string }> = [
      ...snapshot.artifactPaths.map((item) => ({ target: "artifact_file" as const, referenceHash: item.referenceHash })),
      ...snapshot.artifacts.map((item) => ({ target: "artifact_metadata" as const, referenceHash: item.referenceHash })),
      ...snapshot.events.map((item) => ({ target: "event" as const, referenceHash: item.referenceHash })),
      ...snapshot.approvals.map((item) => ({ target: "approval" as const, referenceHash: item.referenceHash })),
      ...snapshot.usage.map((item) => ({ target: "usage" as const, referenceHash: item.referenceHash })),
      { target: "session", referenceHash: snapshot.sessionReferenceHash },
    ];
    const existing = new Set(
      this.#database
        .prepare("SELECT reference_hash FROM delete_receipt_items WHERE receipt_id = ?")
        .all(receiptId)
        .map((row) => readString(row.reference_hash, "delete item reference_hash")),
    );
    const maximum = this.#database
      .prepare("SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM delete_receipt_items WHERE receipt_id = ?")
      .get(receiptId);
    let ordinal = readInteger(maximum?.ordinal, "delete item ordinal") + 1;
    const insert = this.#database.prepare(`
INSERT INTO delete_receipt_items(
  receipt_id, ordinal, target, reference_hash, status, error_json
) VALUES (?, ?, ?, ?, 'pending', NULL)`);
    for (const item of items) {
      if (existing.has(item.referenceHash)) continue;
      insert.run(receiptId, ordinal, item.target, item.referenceHash);
      existing.add(item.referenceHash);
      ordinal += 1;
    }
  }

  #markRecordsDeleting(sessionId: StableId): void {
    this.#database
      .prepare("UPDATE sessions SET deletion_state = 'deleting', updated_at = ? WHERE session_id = ?")
      .run(this.#storage.clock.utcNow(), sessionId);
    this.#database
      .prepare("UPDATE artifacts SET state = 'deleting' WHERE session_id = ?")
      .run(sessionId);
  }

  #findReceipt(sessionId: StableId): ReceiptLookup | null {
    const row = this.#database
      .prepare(`
SELECT r.receipt_id, r.status
FROM delete_receipts r
WHERE r.session_id = ?
  AND EXISTS (
    SELECT 1 FROM delete_receipt_items i
    WHERE i.receipt_id = r.receipt_id AND i.target = 'session'
  )
ORDER BY r.started_at DESC, r.receipt_id DESC LIMIT 1`)
      .get(sessionId);
    if (!row) return null;
    return {
      receiptId: stableIdSchema.parse(row.receipt_id),
      status: readReceiptStatus(row.status),
    };
  }

  #requireCurrentReceipt(receiptId: StableId, sessionId: StableId): ReceiptLookup {
    const lookup = this.#findReceipt(sessionId);
    if (!lookup || lookup.receiptId !== receiptId) {
      throw deletionError(
        "deletion_receipt_corrupt",
        `Delete receipt ${receiptId} is not the current work record for Session ${sessionId}.`,
        "Stop deletion and inspect duplicate or missing receipt records.",
      );
    }
    return lookup;
  }

  #loadTombstone(sessionId: StableId): TombstoneLookup | null {
    const row = this.#database
      .prepare(`
SELECT receipt_id, schema_version, requested_at, completed_at, final_status, purge_state
FROM deleted_session_tombstones WHERE session_id_hash = ?`)
      .get(this.#referenceHash("session", sessionId));
    if (!row) return null;
    if (row.final_status !== "complete") {
      throw deletionError(
        "storage_corrupt",
        "Stored deletion tombstone final status is invalid.",
        "Inspect the deletion tombstone before continuing.",
      );
    }
    if (row.purge_state !== "pending" && row.purge_state !== "complete") {
      throw deletionError(
        "storage_corrupt",
        "Stored deletion tombstone purge state is invalid.",
        "Inspect the deletion tombstone before continuing.",
      );
    }
    return {
      receipt: {
        schemaVersion: readStorageSchemaVersion(row.schema_version),
        receiptId: stableIdSchema.parse(row.receipt_id),
        sessionId,
        status: "complete",
        startedAt: utcTimestampSchema.parse(row.requested_at),
        completedAt: utcTimestampSchema.parse(row.completed_at),
        items: [],
      },
      purgeState: row.purge_state,
    };
  }

  #completePhysicalPurge(tombstone: TombstoneLookup | DeleteReceipt): DeleteReceipt {
    const receipt = "receipt" in tombstone ? tombstone.receipt : tombstone;
    const purgeState = "receipt" in tombstone ? tombstone.purgeState : "pending";
    if (purgeState === "complete") return receipt;

    try {
      this.#storage.completePendingPhysicalPurges();
      const current = this.#loadTombstone(receipt.sessionId);
      if (!current || current.purgeState !== "complete") {
        throw deletionError(
          "storage_corrupt",
          `Deletion tombstone ${receipt.receiptId} disappeared during physical purge.`,
          "Inspect the deletion tombstone before retrying.",
        );
      }
      return receipt;
    } catch (error: unknown) {
      const details = errorDetails(error);
      try {
        this.#database
          .prepare(`
UPDATE deleted_session_tombstones
SET purge_error_json = ?
WHERE receipt_id = ? AND purge_state = 'pending'`)
          .run(canonicalJson(details), receipt.receiptId);
      } catch {
        // The original purge error remains authoritative; a later retry reads
        // the still-pending tombstone and attempts the purge again.
      }
      throw error;
    }
  }

  #bindReferenceHashKey(): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#database
        .prepare("SELECT deletion_hash_key_id FROM storage_installation WHERE singleton = 1")
        .get();
      if (!row) {
        throw deletionError(
          "storage_corrupt",
          "Storage installation identity is missing.",
          "Run or repair the storage migration before deleting Sessions.",
        );
      }
      if (row.deletion_hash_key_id === null) {
        this.#database
          .prepare(`
UPDATE storage_installation SET deletion_hash_key_id = ?
WHERE singleton = 1 AND deletion_hash_key_id IS NULL`)
          .run(this.#referenceHashKeyId);
      } else if (row.deletion_hash_key_id !== this.#referenceHashKeyId) {
        throw deletionError(
          "deletion_hash_key_mismatch",
          "The configured deletion hash key does not match this storage installation.",
          "Restore the installation's original deletion hash key before resuming deletion.",
        );
      }
      this.#database.exec("COMMIT");
    } catch (error: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw translateStorageError(error);
    }
  }

  #sessionExists(sessionId: StableId): boolean {
    return this.#database.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId) !== undefined;
  }

  #itemStatus(
    receiptId: StableId,
    referenceHash: string,
    sessionId?: StableId,
  ): DeleteReceiptItem["status"] | "compacted" {
    const row = this.#database
      .prepare("SELECT status FROM delete_receipt_items WHERE receipt_id = ? AND reference_hash = ?")
      .get(receiptId, referenceHash);
    if (!row) {
      if (sessionId !== undefined && this.#loadTombstone(sessionId)) return "compacted";
      throw deletionError(
        "deletion_receipt_corrupt",
        "A required delete receipt item is missing.",
        "Stop deletion and inspect the receipt.",
      );
    }
    return readItemStatus(row.status);
  }

  #updateItem(
    receiptId: StableId,
    referenceHash: string,
    status: DeleteReceiptItem["status"],
    error: StructuredError | null,
  ): void {
    this.#database
      .prepare(`
UPDATE delete_receipt_items SET status = ?, error_json = ?
WHERE receipt_id = ? AND reference_hash = ?
  AND EXISTS (
    SELECT 1 FROM delete_receipts
    WHERE delete_receipts.receipt_id = delete_receipt_items.receipt_id
      AND delete_receipts.status <> 'complete'
  )`)
      .run(status, error === null ? null : canonicalJson(error), receiptId, referenceHash);
  }

  #markReceiptFailed(receiptId: StableId, error: StructuredError | null = null): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const receipt = this.#database
        .prepare("SELECT status FROM delete_receipts WHERE receipt_id = ?")
        .get(receiptId);
      if (!receipt) {
        this.#database.exec("COMMIT");
        return;
      }
      if (readReceiptStatus(receipt.status) === "complete") {
        this.#database.exec("COMMIT");
        return;
      }
      if (error !== null) {
        const pending = this.#database
          .prepare(`
SELECT reference_hash FROM delete_receipt_items
WHERE receipt_id = ? AND status = 'pending' ORDER BY ordinal LIMIT 1`)
          .get(receiptId);
        if (pending) {
          this.#updateItem(
            receiptId,
            readString(pending.reference_hash, "delete item reference_hash"),
            "failed",
            error,
          );
        }
      }
      this.#database
        .prepare(`
UPDATE delete_receipts SET status = 'failed', completed_at = ?
WHERE receipt_id = ? AND status <> 'complete'`)
        .run(this.#storage.clock.utcNow(), receiptId);
      this.#database.exec("COMMIT");
    } catch (markError: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw translateStorageError(markError);
    }
  }

  #loadReceipt(receiptId: StableId): DeleteReceipt {
    const row = this.#database
      .prepare(`
SELECT receipt_id, session_id, status, started_at, completed_at
FROM delete_receipts WHERE receipt_id = ?`)
      .get(receiptId);
    if (!row) {
      throw deletionError(
        "deletion_receipt_corrupt",
        `Delete receipt ${receiptId} is missing.`,
        "Stop deletion and inspect the storage database.",
      );
    }
    return {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      receiptId: stableIdSchema.parse(row.receipt_id),
      sessionId: stableIdSchema.parse(row.session_id),
      status: readReceiptStatus(row.status),
      startedAt: utcTimestampSchema.parse(row.started_at),
      completedAt: row.completed_at === null ? null : utcTimestampSchema.parse(row.completed_at),
      items: this.#loadItems(receiptId),
    };
  }

  #loadItems(receiptId: StableId): DeleteReceiptItem[] {
    return this.#database
      .prepare(`
SELECT target, reference_hash, status, error_json
FROM delete_receipt_items WHERE receipt_id = ? ORDER BY ordinal`)
      .all(receiptId)
      .map((row) => ({
        target: readTarget(row.target),
        referenceHash: readString(row.reference_hash, "delete item reference_hash"),
        status: readItemStatus(row.status),
        error: parseStoredError(row.error_json),
      }));
  }

  #referenceHash(target: DeleteTarget, reference: string): string {
    return `sha256:${createHmac("sha256", this.#referenceHashKey)
      .update(target)
      .update("\0")
      .update(reference)
      .digest("hex")}`;
  }

  async #hit(
    point: "delete_after_receipt" | "delete_after_artifact_files" | "delete_before_final_commit",
  ): Promise<void> {
    await this.#faultInjector?.hit(point);
  }
}

function countTargets(items: readonly DeleteReceiptItem[], taskCount: number): Record<string, number> {
  const counts: Record<string, number> = { task: taskCount };
  for (const item of items) counts[item.target] = (counts[item.target] ?? 0) + 1;
  return counts;
}

function readCount(row: Readonly<Record<string, unknown>> | undefined): number {
  return readInteger(row?.count, "row count");
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw deletionError("storage_corrupt", `Stored ${label} is invalid.`, "Inspect or restore the database.");
  }
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw deletionError("storage_corrupt", `Stored ${label} is invalid.`, "Inspect or restore the database.");
  }
  return value;
}

function readReceiptStatus(value: unknown): DeleteReceipt["status"] {
  if (value === "in_progress" || value === "complete" || value === "failed") return value;
  throw deletionError("storage_corrupt", "Stored delete receipt status is invalid.", "Inspect the database.");
}

function readStorageSchemaVersion(value: unknown): typeof STORAGE_RECORD_SCHEMA_VERSION {
  const version = readInteger(value, "storage record schema version");
  if (version !== STORAGE_RECORD_SCHEMA_VERSION) {
    throw deletionError(
      "storage_schema_unsupported",
      `Stored deletion record schema version ${version} is not supported.`,
      "Open the database with a compatible application version.",
    );
  }
  return STORAGE_RECORD_SCHEMA_VERSION;
}

function readItemStatus(value: unknown): DeleteReceiptItem["status"] {
  if (value === "pending" || value === "deleted" || value === "missing" || value === "failed") {
    return value;
  }
  throw deletionError("storage_corrupt", "Stored delete item status is invalid.", "Inspect the database.");
}

function readTarget(value: unknown): DeleteTarget {
  if (
    value === "session" || value === "event" || value === "approval" || value === "usage" ||
    value === "transcript" || value === "artifact_metadata" || value === "artifact_file"
  ) return value;
  throw deletionError("storage_corrupt", "Stored delete item target is invalid.", "Inspect the database.");
}

function parseStoredError(value: unknown): StructuredError | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw deletionError("storage_corrupt", "Stored delete item error is invalid.", "Inspect the database.");
  }
  try {
    return structuredErrorSchema.parse(JSON.parse(value));
  } catch {
    throw deletionError("storage_corrupt", "Stored delete item error JSON is invalid.", "Inspect the database.");
  }
}

function errorDetails(error: unknown): StructuredError {
  return error instanceof StorageError ? error.details : translateStorageError(error).details;
}

function sessionNotFound(sessionId: StableId): StorageError {
  return deletionError(
    "session_not_found",
    `Session ${sessionId} does not exist.`,
    "Reload the Session list before retrying deletion.",
  );
}

function uncompactReceipt(receiptId: StableId): StorageError {
  return deletionError(
    "deletion_receipt_corrupt",
    `Completed raw delete receipt ${receiptId} was not compacted to a tombstone.`,
    "Inspect and repair the deletion receipt before continuing.",
  );
}

function deletionError(category: string, message: string, recovery: string): StorageError {
  return storageError(category, message, false, recovery);
}
