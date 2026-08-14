import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { StableId, StructuredError } from "../src/shared/contracts.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type DeleteReceipt,
  type SessionDeletionCoordinator,
} from "../src/storage/contracts.js";
import {
  RETENTION_REPORT_SCHEMA_VERSION,
  RetentionService,
} from "../src/storage/retention-service.js";
import { SessionDeletionService } from "../src/storage/session-deletion-service.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";

const NOW = "2026-08-12T12:00:00.000Z";
const TEST_SHA256 = `sha256:${"0".repeat(64)}`;
const databases: SqliteStorageDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("RetentionService", () => {
  it("deletes every unpinned active Session expired at or before the cutoff in stable order", async () => {
    const storage = database();
    const sameExpiry = "2026-08-12T11:00:00.000Z";
    const lowId = "00000000-0000-4000-8000-000000000001";
    const highId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const calls: StableId[] = [];
    insertSession(storage, highId, sameExpiry);
    insertSession(storage, lowId, sameExpiry);
    const oldest = insertSession(storage, randomUUID(), "2026-08-01T00:00:00.000Z");
    const service = new RetentionService(storage, coordinator(async (sessionId) => {
      calls.push(sessionId);
      deleteSessionRow(storage, sessionId);
      return completeReceipt(sessionId);
    }));

    const report = await service.run();

    expect(calls).toEqual([oldest, lowId, highId]);
    expect(report).toMatchObject({
      schemaVersion: RETENTION_REPORT_SCHEMA_VERSION,
      startedAt: NOW,
      completedAt: NOW,
      cutoffAt: NOW,
      scanned: 3,
      deleted: 3,
      failed: 0,
    });
    expect(report.items.map((item) => item.status)).toEqual(["deleted", "deleted", "deleted"]);
  });

  it("applies expiry/pin only before deletion and always resumes durable deleting Sessions", async () => {
    const storage = database();
    const boundary = insertSession(storage, randomUUID(), NOW);
    insertSession(storage, randomUUID(), "2026-08-12T12:00:00.001Z");
    insertSession(storage, randomUUID(), "2026-08-01T00:00:00.000Z", { pinned: true });
    insertSession(storage, randomUUID(), null);
    insertSession(storage, randomUUID(), "2026-08-01T00:00:00.000Z", { deleting: true });
    const futureDeleting = insertSession(
      storage,
      randomUUID(),
      "2026-08-12T12:00:00.001Z",
      { deleting: true },
    );
    insertIncompleteReceipt(storage, futureDeleting, "failed");
    const pinnedDeleting = insertSession(
      storage,
      randomUUID(),
      "2026-08-01T00:00:00.000Z",
      { pinned: true, deleting: true },
    );
    insertIncompleteReceipt(storage, pinnedDeleting, "in_progress");
    const calls: StableId[] = [];
    const service = new RetentionService(storage, coordinator(async (sessionId) => {
      calls.push(sessionId);
      deleteSessionRow(storage, sessionId);
      return completeReceipt(sessionId);
    }));

    const report = await service.run();

    expect(calls).toEqual([pinnedDeleting, boundary, futureDeleting]);
    expect(report).toMatchObject({ scanned: 3, deleted: 3, failed: 0 });
  });

  it("isolates thrown and incomplete deletion failures and continues later Sessions", async () => {
    const storage = database();
    const first = insertSession(storage, randomUUID(), "2026-08-01T00:00:00.000Z");
    const second = insertSession(storage, randomUUID(), "2026-08-02T00:00:00.000Z");
    const third = insertSession(storage, randomUUID(), "2026-08-03T00:00:00.000Z");
    const calls: StableId[] = [];
    const service = new RetentionService(storage, coordinator(async (sessionId) => {
      calls.push(sessionId);
      if (sessionId === first) throw storageFailure("artifact locked");
      if (sessionId === second) return failedReceipt(sessionId);
      deleteSessionRow(storage, sessionId);
      return completeReceipt(sessionId);
    }));

    const report = await service.run();

    expect(calls).toEqual([first, second, third]);
    expect(report).toMatchObject({ scanned: 3, deleted: 1, failed: 2 });
    expect(report.items).toEqual([
      expect.objectContaining({
        sessionId: first,
        status: "failed",
        receiptId: null,
        error: expect.objectContaining({ category: "delete_incomplete", message: "artifact locked" }),
      }),
      expect.objectContaining({
        sessionId: second,
        status: "failed",
        receiptId: expect.any(String),
        error: expect.objectContaining({ category: "delete_incomplete" }),
      }),
      expect.objectContaining({ sessionId: third, status: "deleted", error: null }),
    ]);
  });

  it("resumes a failed durable deletion receipt on the next retention run", async () => {
    const storage = database();
    const expired = insertSession(storage, randomUUID(), "2026-08-01T00:00:00.000Z");
    insertArtifact(storage, expired);
    let fileAttempts = 0;
    const deletion = new SessionDeletionService(storage, {
      artifactFileDeleter: {
        finalizeSessionDirectory: async () => "missing",
        deleteArtifactFile: async () => {
          fileAttempts += 1;
          if (fileAttempts === 1) throw new Error("simulated file lock");
          return "missing";
        },
      },
      referenceHashKey: "retention-test-only-reference-key",
    });
    const service = new RetentionService(storage, deletion);

    const failed = await service.run();
    const failedItem = failed.items[0];
    if (!failedItem || failedItem.receiptId === null) throw new Error("Expected a durable delete receipt.");

    expect(failed).toMatchObject({ scanned: 1, deleted: 0, failed: 1 });
    expect(failedItem).toMatchObject({
      sessionId: expired,
      status: "failed",
      receiptId: expect.any(String),
    });
    expect(storage.database
      .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
      .get(expired)).toEqual({ deletion_state: "deleting" });
    expect(storage.database
      .prepare("SELECT status FROM delete_receipts WHERE receipt_id = ?")
      .get(failedItem.receiptId)).toEqual({ status: "failed" });

    const completed = await service.run();

    expect(completed).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
    expect(completed.items[0]).toMatchObject({
      sessionId: expired,
      status: "deleted",
      receiptId: failedItem.receiptId,
      error: null,
    });
    expect(fileAttempts).toBe(2);
    expect(storage.database
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
      .get(expired)).toEqual({ count: 0 });
  });

  it("resumes an in-progress receipt and reports an unknown interruption conservatively", async () => {
    const storage = database();
    const expired = insertSession(storage, randomUUID(), "2026-08-01T00:00:00.000Z");
    let interrupted = false;
    const deletion = new SessionDeletionService(storage, {
      artifactFileDeleter: {
        deleteArtifactFile: async () => "missing",
        finalizeSessionDirectory: async () => "missing",
      },
      referenceHashKey: "retention-test-only-reference-key",
      faultInjector: {
        hit: (point) => {
          if (point === "delete_after_receipt" && !interrupted) {
            interrupted = true;
            throw new Error("simulated process interruption");
          }
        },
      },
    });
    const service = new RetentionService(storage, deletion);

    const interruptedReport = await service.run();
    const durableReceipt = storage.database
      .prepare("SELECT receipt_id, status FROM delete_receipts WHERE session_id = ?")
      .get(expired);

    expect(durableReceipt).toMatchObject({ status: "in_progress" });
    expect(interruptedReport).toMatchObject({ scanned: 1, deleted: 0, failed: 1 });
    expect(interruptedReport.items[0]).toEqual(expect.objectContaining({
      sessionId: expired,
      status: "failed",
      receiptId: durableReceipt?.receipt_id,
      error: expect.objectContaining({
        category: "retention_delete_failed",
        message: "simulated process interruption",
        retryable: false,
        sideEffectStatus: "unknown",
      }),
    }));

    const completed = await service.run();

    expect(completed).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
    expect(completed.items[0]).toMatchObject({
      sessionId: expired,
      status: "deleted",
      receiptId: durableReceipt?.receipt_id,
      error: null,
    });
  });

  it("is idempotent across repeated scans after completed deletions", async () => {
    const storage = database();
    const expired = insertSession(storage, randomUUID(), "2026-08-01T00:00:00.000Z");
    let calls = 0;
    const service = new RetentionService(storage, coordinator(async (sessionId) => {
      calls += 1;
      deleteSessionRow(storage, sessionId);
      return completeReceipt(sessionId);
    }));

    await expect(service.run()).resolves.toMatchObject({ scanned: 1, deleted: 1 });
    await expect(service.run()).resolves.toMatchObject({
      scanned: 0,
      deleted: 0,
      failed: 0,
      items: [],
    });
    expect(calls).toBe(1);
    expect(storage.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?").get(expired)).toEqual({
      count: 0,
    });
  });
});

function database(): SqliteStorageDatabase {
  const storage = new SqliteStorageDatabase(":memory:", {
    clock: { utcNow: () => NOW, monotonicNowMs: () => 0 },
  });
  databases.push(storage);
  return storage;
}

function insertSession(
  storage: SqliteStorageDatabase,
  sessionId: StableId,
  expiresAt: string | null,
  options: { pinned?: boolean; deleting?: boolean } = {},
): StableId {
  const workspaceId = randomUUID();
  storage.database.prepare(`
INSERT INTO workspaces(
  workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at
) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      workspaceId,
      STORAGE_RECORD_SCHEMA_VERSION,
      `C:\\workspace\\${workspaceId}`,
      `C:\\workspace\\${workspaceId}`,
      `fingerprint:${workspaceId}`,
      NOW,
    );
  storage.database.prepare(`
INSERT INTO sessions(
  session_id, schema_version, workspace_id, goal, pinned,
  created_at, updated_at, expires_at, config_version, tool_catalog_hash,
  create_bundle_hash, last_sequence, deletion_state
) VALUES (?, ?, ?, 'retention test', ?, ?, ?, ?, 'config:v1',
          'sha256:catalog', ?, -1, ?)`)
    .run(
      sessionId,
      STORAGE_RECORD_SCHEMA_VERSION,
      workspaceId,
      options.pinned ? 1 : 0,
      NOW,
      NOW,
      expiresAt,
      TEST_SHA256,
      options.deleting ? "deleting" : "active",
    );
  return sessionId;
}

function deleteSessionRow(storage: SqliteStorageDatabase, sessionId: StableId): void {
  storage.database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
}

function insertArtifact(storage: SqliteStorageDatabase, sessionId: StableId): StableId {
  const artifactId = randomUUID();
  storage.database.prepare(`
INSERT INTO artifacts(
  artifact_id, schema_version, session_id, state, staged_relative_path,
  ready_relative_path, media_type, byte_length, sha256, sensitivity,
  created_at, verified_at, error_json
) VALUES (?, ?, ?, 'ready', NULL, ?, 'text/plain', 4, ?, 'normal', ?, ?, NULL)`)
    .run(
      artifactId,
      STORAGE_RECORD_SCHEMA_VERSION,
      sessionId,
      `artifacts/${sessionId}/${artifactId}.bin`,
      TEST_SHA256,
      NOW,
      NOW,
    );
  return artifactId;
}

function insertIncompleteReceipt(
  storage: SqliteStorageDatabase,
  sessionId: StableId,
  status: "failed" | "in_progress",
): StableId {
  const receiptId = randomUUID();
  storage.database.prepare(`
INSERT INTO delete_receipts(
  receipt_id, schema_version, session_id, status, started_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      receiptId,
      STORAGE_RECORD_SCHEMA_VERSION,
      sessionId,
      status,
      NOW,
      status === "failed" ? NOW : null,
    );
  storage.database.prepare(`
INSERT INTO delete_receipt_items(
  receipt_id, ordinal, target, reference_hash, status, error_json
) VALUES (?, 0, 'session', ?, 'pending', NULL)`)
    .run(receiptId, TEST_SHA256);
  return receiptId;
}

function coordinator(
  implementation: (sessionId: StableId) => Promise<DeleteReceipt>,
): SessionDeletionCoordinator {
  return { delete: implementation };
}

function completeReceipt(sessionId: StableId): DeleteReceipt {
  return {
    schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
    receiptId: randomUUID(),
    sessionId,
    status: "complete",
    startedAt: NOW,
    completedAt: NOW,
    error: null,
    items: [],
  };
}

function failedReceipt(sessionId: StableId): DeleteReceipt {
  const error: StructuredError = {
    category: "delete_incomplete",
    message: "one file remains",
    retryable: true,
    sideEffectStatus: "none",
    recovery: "Retry the receipt.",
  };
  return {
    schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
    receiptId: randomUUID(),
    sessionId,
    status: "failed",
    startedAt: NOW,
    completedAt: null,
    error,
    items: [{ target: "artifact_file", referenceHash: "sha256:file", status: "failed", error }],
  };
}

function storageFailure(message: string) {
  const error = new Error(message) as Error & { details: StructuredError };
  error.details = {
    category: "delete_incomplete",
    message,
    retryable: true,
    sideEffectStatus: "none",
    recovery: "Retry later.",
  };
  return error;
}
