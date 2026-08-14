import type { DatabaseSync } from "node:sqlite";

import {
  stableIdSchema,
  structuredErrorSchema,
  utcTimestampSchema,
  type StableId,
  type StructuredError,
  type UtcTimestamp,
} from "../shared/contracts.js";
import type { DeleteReceipt, SessionDeletionCoordinator } from "./contracts.js";
import { SqliteStorageDatabase } from "./sqlite/sqlite-database.js";
import { translateStorageError } from "./sqlite/sqlite-errors.js";

export const RETENTION_REPORT_SCHEMA_VERSION = 1;

export interface RetentionReportItem {
  readonly sessionId: StableId;
  readonly expiresAt: UtcTimestamp;
  readonly status: "deleted" | "failed";
  readonly receiptId: StableId | null;
  readonly error: StructuredError | null;
}

export interface RetentionReport {
  readonly schemaVersion: typeof RETENTION_REPORT_SCHEMA_VERSION;
  readonly startedAt: UtcTimestamp;
  readonly completedAt: UtcTimestamp;
  readonly cutoffAt: UtcTimestamp;
  readonly scanned: number;
  readonly deleted: number;
  readonly failed: number;
  readonly items: readonly RetentionReportItem[];
}

/**
 * Applies the local retention policy to a stable scan of eligible Sessions.
 * Deletion remains delegated to the durable coordinator so database metadata,
 * Artifact files, receipts and tombstones keep one source of truth.
 */
export class RetentionService {
  readonly #storage: SqliteStorageDatabase;
  readonly #database: DatabaseSync;
  readonly #deletionCoordinator: SessionDeletionCoordinator;

  constructor(
    storage: SqliteStorageDatabase,
    deletionCoordinator: SessionDeletionCoordinator,
  ) {
    this.#storage = storage;
    this.#database = storage.database;
    this.#deletionCoordinator = deletionCoordinator;
  }

  async run(): Promise<RetentionReport> {
    // A prior deletion may have removed all Session metadata but crashed or
    // encountered a reader before its WAL purge barrier. Recover that global
    // physical state before scanning live retention candidates.
    this.#storage.completePendingPhysicalPurges();
    const startedAt = this.#storage.clock.utcNow();
    const cutoffAt = startedAt;
    let eligible: readonly EligibleSession[];
    try {
      eligible = this.#scan(cutoffAt);
    } catch (error: unknown) {
      throw translateStorageError(error);
    }

    const items: RetentionReportItem[] = [];
    for (const session of eligible) {
      try {
        const receipt = await this.#deletionCoordinator.delete(session.sessionId);
        if (receipt.status !== "complete") {
          items.push({
            sessionId: session.sessionId,
            expiresAt: session.expiresAt,
            status: "failed",
            receiptId: receipt.receiptId,
            error: incompleteReceiptError(receipt),
          });
          continue;
        }
        items.push({
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          status: "deleted",
          receiptId: receipt.receiptId,
          error: null,
        });
      } catch (error: unknown) {
        items.push({
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          status: "failed",
          receiptId: this.#findIncompleteReceiptId(session.sessionId) ?? receiptIdFrom(error),
          error: errorDetails(error),
        });
      }
    }

    const deleted = items.filter((item) => item.status === "deleted").length;
    return {
      schemaVersion: RETENTION_REPORT_SCHEMA_VERSION,
      startedAt,
      completedAt: this.#storage.clock.utcNow(),
      cutoffAt,
      scanned: items.length,
      deleted,
      failed: items.length - deleted,
      items,
    };
  }

  #scan(cutoffAt: UtcTimestamp): readonly EligibleSession[] {
    return this.#database
      .prepare(`
SELECT session_id, COALESCE(expires_at, updated_at) AS retention_reference_at
FROM sessions
WHERE (
    (
      deletion_state = 'active'
      AND pinned = 0
      AND expires_at IS NOT NULL
      AND expires_at <= ?
    )
    OR (
      deletion_state = 'deleting'
      AND EXISTS (
        SELECT 1 FROM delete_receipts
        WHERE delete_receipts.session_id = sessions.session_id
          AND delete_receipts.status IN ('in_progress', 'failed')
          AND EXISTS (
            SELECT 1 FROM delete_receipt_items
            WHERE delete_receipt_items.receipt_id = delete_receipts.receipt_id
              AND delete_receipt_items.target = 'session'
          )
      )
    )
  )
ORDER BY retention_reference_at, session_id`)
      .all(cutoffAt)
      .map((row) => ({
        sessionId: stableIdSchema.parse(row.session_id),
        expiresAt: utcTimestampSchema.parse(row.retention_reference_at),
      }));
  }

  #findIncompleteReceiptId(sessionId: StableId): StableId | null {
    try {
      const row = this.#database
        .prepare(`
SELECT receipt_id FROM delete_receipts
WHERE session_id = ? AND status IN ('in_progress', 'failed')
  AND EXISTS (
    SELECT 1 FROM delete_receipt_items
    WHERE delete_receipt_items.receipt_id = delete_receipts.receipt_id
      AND delete_receipt_items.target = 'session'
  )
ORDER BY started_at DESC, receipt_id DESC LIMIT 1`)
        .get(sessionId);
      if (!row) return null;
      return stableIdSchema.parse(row.receipt_id);
    } catch {
      // The original coordinator failure remains the primary report. A later
      // storage recovery inspection will surface an unreadable receipt table.
      return null;
    }
  }
}

interface EligibleSession {
  readonly sessionId: StableId;
  readonly expiresAt: UtcTimestamp;
}

function incompleteReceiptError(receipt: DeleteReceipt): StructuredError {
  if (receipt.error !== null) return receipt.error;
  const itemError = receipt.items.find((item) => item.status === "failed")?.error;
  return itemError ?? {
    category: "delete_incomplete",
    message: `Session deletion receipt ${receipt.receiptId} is ${receipt.status}.`,
    retryable: true,
    sideEffectStatus: "none",
    recovery: "Resume the same durable delete receipt on the next retention run.",
  };
}

function errorDetails(error: unknown): StructuredError {
  if (typeof error === "object" && error !== null && "details" in error) {
    const parsed = structuredErrorSchema.safeParse((error as { readonly details: unknown }).details);
    if (parsed.success) return parsed.data;
  }
  return {
    category: "retention_delete_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    sideEffectStatus: "unknown",
    recovery: "Inspect the durable deletion receipt before deciding whether to resume retention.",
  };
}

function receiptIdFrom(error: unknown): StableId | null {
  if (typeof error !== "object" || error === null || !("receiptId" in error)) return null;
  const parsed = stableIdSchema.safeParse((error as { readonly receiptId: unknown }).receiptId);
  return parsed.success ? parsed.data : null;
}
