import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import type { StableId } from "../src/shared/contracts.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type CreateSessionBundle,
} from "../src/storage/contracts.js";
import {
  SessionDeletionService,
  type ArtifactFileDeleteRequest,
  type ArtifactFileDeleter,
} from "../src/storage/session-deletion-service.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";

const NOW = "2026-08-12T12:00:00.000Z";
const HASH_KEY = "test-only-install-local-deletion-key";
const openDatabases: SqliteStorageDatabase[] = [];
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe("SessionDeletionService", () => {
  it("persists intent before deleting files, then atomically erases Session-owned metadata", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    const artifactId = insertArtifact(storage, input.session.sessionId);
    const approvalId = insertApproval(storage, input.session.sessionId);
    const usageId = insertUsage(storage, input.session.sessionId);
    const observed: Array<{
      request: ArtifactFileDeleteRequest;
      receiptStatus: unknown;
      sessionState: unknown;
      artifactState: unknown;
      itemStatus: unknown;
    }> = [];
    const deleter: ArtifactFileDeleter = {
      finalizeSessionDirectory: async () => "missing",
      deleteArtifactFile: async (request) => {
        observed.push({
          request,
          receiptStatus: storage.database
            .prepare("SELECT status FROM delete_receipts WHERE session_id = ?")
            .get(request.sessionId)?.status,
          sessionState: storage.database
            .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
            .get(request.sessionId)?.deletion_state,
          artifactState: storage.database
            .prepare("SELECT state FROM artifacts WHERE artifact_id = ?")
            .get(request.artifactId)?.state,
          itemStatus: storage.database
            .prepare(`
SELECT status FROM delete_receipt_items
WHERE target = 'artifact_file' ORDER BY ordinal LIMIT 1`)
            .get()?.status,
        });
        return "deleted";
      },
    };

    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: deleter,
      referenceHashKey: HASH_KEY,
    });
    const receipt = await service.delete(input.session.sessionId);

    expect(observed).toEqual([
      {
        request: {
          sessionId: input.session.sessionId,
          artifactId,
          relativePath: `artifacts/${input.session.sessionId}/${artifactId}.bin`,
        },
        receiptStatus: "in_progress",
        sessionState: "deleting",
        artifactState: "deleting",
        itemStatus: "pending",
      },
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId: input.session.sessionId,
      status: "complete",
      startedAt: NOW,
      completedAt: NOW,
    });
    expect(receipt.items.map((item) => [item.target, item.status])).toEqual([
      ["artifact_file", "deleted"],
      ["artifact_metadata", "deleted"],
      ["event", "deleted"],
      ["approval", "deleted"],
      ["usage", "deleted"],
      ["session", "deleted"],
    ]);
    expect(receipt.items.every((item) => item.referenceHash.startsWith("sha256:"))).toBe(true);
    expect(receipt.items.some((item) => item.referenceHash.includes(input.session.sessionId))).toBe(false);

    for (const [table, identifier, id] of [
      ["sessions", "session_id", input.session.sessionId],
      ["tasks", "session_id", input.session.sessionId],
      ["agent_events", "session_id", input.session.sessionId],
      ["artifacts", "artifact_id", artifactId],
      ["approvals", "approval_id", approvalId],
      ["usage_entries", "usage_id", usageId],
    ] as const) {
      expect(count(storage, table, identifier, id), `${table} should be erased`).toBe(0);
    }
    expect(count(storage, "delete_receipts", "receipt_id", receipt.receiptId)).toBe(0);
    expect(storage.database.prepare("SELECT COUNT(*) AS count FROM delete_receipt_items").get()).toEqual({
      count: 0,
    });
    expect(count(storage, "deleted_session_tombstones", "receipt_id", receipt.receiptId)).toBe(1);
    const tombstone = storage.database
      .prepare(`
SELECT session_id_hash, final_status, target_counts_json
FROM deleted_session_tombstones WHERE receipt_id = ?`)
      .get(receipt.receiptId);
    expect(tombstone?.session_id_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(tombstone?.session_id_hash).not.toBe(input.session.sessionId);
    expect(tombstone?.session_id_hash).toBe(
      receipt.items.find((item) => item.target === "session")?.referenceHash,
    );
    expect(tombstone?.final_status).toBe("complete");
    expect(JSON.parse(String(tombstone?.target_counts_json))).toEqual({
      approval: 1,
      artifact_file: 1,
      artifact_metadata: 1,
      event: 1,
      session: 1,
      task: 1,
      usage: 1,
    });
    expect(count(storage, "workspaces", "workspace_id", input.session.workspace.workspaceId)).toBe(0);

    const retained = JSON.stringify(storage.database
      .prepare("SELECT * FROM deleted_session_tombstones WHERE receipt_id = ?")
      .get(receipt.receiptId));
    for (const secret of [
      input.session.sessionId,
      input.session.goal,
      input.session.workspace.root.normalizedPath,
      ...receipt.items
        .filter((item) => item.target !== "session")
        .map((item) => item.referenceHash),
    ]) {
      expect(retained).not.toContain(secret);
    }
  });

  it("persists a file failure and resumes the same receipt idempotently", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    insertArtifact(storage, input.session.sessionId);
    let attempts = 0;
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: {
        finalizeSessionDirectory: async () => "missing",
        deleteArtifactFile: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("simulated access denied");
          return "missing";
        },
      },
      referenceHashKey: HASH_KEY,
    });

    const failed = await service.delete(input.session.sessionId);
    expect(failed.status).toBe("failed");
    expect(failed.items).toContainEqual(expect.objectContaining({
      target: "artifact_file",
      status: "failed",
      error: expect.objectContaining({ sideEffectStatus: "none" }),
    }));
    expect(storage.database
      .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
      .get(input.session.sessionId)).toEqual({ deletion_state: "deleting" });
    expect(count(storage, "agent_events", "session_id", input.session.sessionId)).toBe(1);
    expect(count(storage, "artifacts", "session_id", input.session.sessionId)).toBe(1);

    const completed = await service.delete(input.session.sessionId);
    expect(completed.receiptId).toBe(failed.receiptId);
    expect(completed.status).toBe("complete");
    expect(completed.items).toContainEqual(expect.objectContaining({
      target: "artifact_file",
      status: "missing",
      error: null,
    }));
    expect(attempts).toBe(2);

    await expect(service.delete(input.session.sessionId)).resolves.toEqual({
      ...completed,
      items: [],
    });
    expect(attempts).toBe(2);
    expect(storage.database.prepare("SELECT COUNT(*) AS count FROM delete_receipts").get()).toEqual({
      count: 0,
    });
  });

  it("keeps a shared Workspace until its last Session is deleted", async () => {
    const storage = createDatabase();
    const first = await createSession(storage);
    const second = bundle({
      workspaceId: first.session.workspace.workspaceId,
      workspacePath: first.session.workspace.root.normalizedPath,
      workspaceFingerprint: first.session.workspace.fingerprint,
      workspaceCreatedAt: first.session.workspace.createdAt,
    });
    await new SqliteSessionRepository(storage, {
      deletedSessionIdentity: noDeletedSessions,
    }).create(second);
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "missing"),
      referenceHashKey: HASH_KEY,
    });

    await service.delete(first.session.sessionId);
    expect(count(storage, "workspaces", "workspace_id", first.session.workspace.workspaceId)).toBe(1);

    await service.delete(second.session.sessionId);
    expect(count(storage, "workspaces", "workspace_id", first.session.workspace.workspaceId)).toBe(0);
  });

  it("returns a tombstone summary across coordinator instances after completion", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    insertArtifact(storage, input.session.sessionId);
    const first = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "deleted"),
      referenceHashKey: HASH_KEY,
    });
    const complete = await first.delete(input.session.sessionId);
    const second = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => {
        throw new Error("must not touch files after tombstone completion");
      }),
      referenceHashKey: HASH_KEY,
    });

    await expect(second.delete(input.session.sessionId)).resolves.toEqual({
      ...complete,
      items: [],
    });
  });

  it("prevents a deleted Session identity from being recreated or hidden by its tombstone", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    const deletion = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "missing"),
      referenceHashKey: HASH_KEY,
    });
    await deletion.delete(input.session.sessionId);
    const repository = new SqliteSessionRepository(storage, {
      deletedSessionIdentity: deletion,
    });

    await expect(repository.create(input)).rejects.toMatchObject({
      details: { category: "deleted_session_id_conflict" },
    });

    // A lower-level writer that bypasses the repository cannot be silently
    // masked by the old tombstone when deletion is requested again.
    const recreatedWorkspaceId = randomUUID();
    storage.database.prepare(`
INSERT INTO workspaces(workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at)
VALUES (?, 1, ?, ?, 'recreated', ?)`)
      .run(recreatedWorkspaceId, "C:/recreated", "C:/recreated", NOW);
    storage.database.prepare(`
INSERT INTO sessions(
  session_id, schema_version, workspace_id, goal, pinned, created_at, updated_at,
  expires_at, config_version, tool_catalog_hash, create_bundle_hash, last_sequence, deletion_state
) VALUES (?, 1, ?, 'recreated', 0, ?, ?, NULL, 'config:v1', ?, ?, -1, 'active')`)
      .run(
        input.session.sessionId,
        recreatedWorkspaceId,
        NOW,
        NOW,
        `sha256:${"a".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
      );
    await expect(deletion.delete(input.session.sessionId)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
  });

  it("rejects a different deletion hash key without changing unfinished work", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    insertArtifact(storage, input.session.sessionId);
    let interrupted = false;
    const original = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "missing"),
      referenceHashKey: HASH_KEY,
      faultInjector: {
        hit: (point) => {
          if (point === "delete_after_receipt" && !interrupted) {
            interrupted = true;
            throw new Error("simulated interruption");
          }
        },
      },
    });
    await expect(original.delete(input.session.sessionId)).rejects.toThrow("simulated interruption");
    const before = storage.database
      .prepare("SELECT receipt_id, status FROM delete_receipts WHERE session_id = ?")
      .get(input.session.sessionId);

    expect(() => new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "missing"),
      referenceHashKey: "a-different-installation-key",
    })).toThrow(expect.objectContaining({
      details: expect.objectContaining({ category: "deletion_hash_key_mismatch" }),
    }));
    expect(storage.database
      .prepare("SELECT receipt_id, status FROM delete_receipts WHERE session_id = ?")
      .get(input.session.sessionId)).toEqual(before);
    expect(storage.database.prepare("SELECT COUNT(*) AS count FROM delete_receipts").get()).toEqual({
      count: 1,
    });
  });

  it("coalesces concurrent deletes for one Session into one durable work record", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    insertArtifact(storage, input.session.sessionId);
    let releaseFileDelete!: () => void;
    const fileDeleteStarted = new Promise<void>((resolve) => {
      releaseFileDelete = resolve;
    });
    let fileCalls = 0;
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: {
        finalizeSessionDirectory: async () => "missing",
        deleteArtifactFile: async () => {
          fileCalls += 1;
          await fileDeleteStarted;
          return "deleted";
        },
      },
      referenceHashKey: HASH_KEY,
    });

    const deletes = Promise.all([
      service.delete(input.session.sessionId),
      service.delete(input.session.sessionId),
      service.delete(input.session.sessionId),
    ]);
    await Promise.resolve();
    releaseFileDelete();
    const receipts = await deletes;

    expect(new Set(receipts.map((receipt) => receipt.receiptId))).toEqual(
      new Set([receipts[0]!.receiptId]),
    );
    expect(receipts.every((receipt) => receipt.status === "complete")).toBe(true);
    expect(fileCalls).toBe(1);
    expect(storage.database
      .prepare("SELECT COUNT(*) AS count FROM delete_receipts WHERE session_id = ?")
      .get(input.session.sessionId)).toEqual({ count: 0 });
    expect(storage.database
      .prepare("SELECT COUNT(*) AS count FROM deleted_session_tombstones")
      .get()).toEqual({ count: 1 });
  });

  it("does not downgrade a completed receipt when a concurrent deleter finishes late", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    insertArtifact(storage, input.session.sessionId);
    insertArtifact(storage, input.session.sessionId);
    let releaseLateDelete!: () => void;
    const firstCompleted = new Promise<void>((resolve) => {
      releaseLateDelete = resolve;
    });
    const first = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "deleted"),
      referenceHashKey: HASH_KEY,
    });
    const late = new SessionDeletionService(storage, {
      artifactFileDeleter: {
        finalizeSessionDirectory: async () => "missing",
        deleteArtifactFile: async () => {
          await firstCompleted;
          throw new Error("late delete failure");
        },
      },
      referenceHashKey: HASH_KEY,
    });

    const firstDelete = first.delete(input.session.sessionId);
    const lateDelete = late.delete(input.session.sessionId);
    const receipts = await Promise.all([
      firstDelete.finally(() => releaseLateDelete()),
      lateDelete,
    ]);

    expect(receipts[1]).toEqual({ ...receipts[0], items: [] });
    expect(receipts[0]).toMatchObject({ status: "complete" });
    expect(receipts[0]!.items.filter((item) => item.target === "artifact_file")).toHaveLength(2);
    expect(receipts[0]!.items.filter((item) => item.target === "artifact_file"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "deleted", error: null }),
      ]));
    expect(storage.database
      .prepare("SELECT receipt_id, status FROM delete_receipts WHERE session_id = ?")
      .get(input.session.sessionId)).toBeUndefined();
    expect(storage.database
      .prepare("SELECT COUNT(*) AS count FROM delete_receipts WHERE session_id = ?")
      .get(input.session.sessionId)).toEqual({ count: 0 });
  });

  it("rolls back all metadata erasure and can resume after a database failure", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    insertArtifact(storage, input.session.sessionId);
    insertApproval(storage, input.session.sessionId);
    insertUsage(storage, input.session.sessionId);
    storage.database.exec(`
CREATE TRIGGER fail_approval_delete
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'simulated approval deletion failure');
END;`);
    let fileCalls = 0;
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: {
        finalizeSessionDirectory: async () => "missing",
        deleteArtifactFile: async () => {
          fileCalls += 1;
          return "deleted";
        },
      },
      referenceHashKey: HASH_KEY,
    });

    const failed = await service.delete(input.session.sessionId);
    expect(failed.status).toBe("failed");
    expect(fileCalls).toBe(1);
    expect(count(storage, "sessions", "session_id", input.session.sessionId)).toBe(1);
    expect(count(storage, "tasks", "session_id", input.session.sessionId)).toBe(1);
    expect(count(storage, "agent_events", "session_id", input.session.sessionId)).toBe(1);
    expect(count(storage, "artifacts", "session_id", input.session.sessionId)).toBe(1);
    expect(count(storage, "approvals", "session_id", input.session.sessionId)).toBe(1);
    expect(count(storage, "usage_entries", "session_id", input.session.sessionId)).toBe(1);
    expect(count(storage, "deleted_session_tombstones", "receipt_id", failed.receiptId)).toBe(0);

    storage.database.exec("DROP TRIGGER fail_approval_delete");
    const completed = await service.delete(input.session.sessionId);
    expect(completed.receiptId).toBe(failed.receiptId);
    expect(completed.status).toBe("complete");
    expect(fileCalls).toBe(1);
  });

  it("discovers an Artifact inserted during deletion before finalizing", async () => {
    const storage = createDatabase();
    const input = await createSession(storage);
    const firstArtifact = insertArtifact(storage, input.session.sessionId);
    let secondArtifact: StableId | null = null;
    const deleted: StableId[] = [];
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: {
        finalizeSessionDirectory: async () => "missing",
        deleteArtifactFile: async ({ artifactId }) => {
          deleted.push(artifactId);
          if (secondArtifact === null) {
            secondArtifact = insertArtifact(storage, input.session.sessionId);
          }
          return "deleted";
        },
      },
      referenceHashKey: HASH_KEY,
    });

    const receipt = await service.delete(input.session.sessionId);

    expect(receipt.status).toBe("complete");
    expect(secondArtifact).not.toBeNull();
    expect(deleted).toEqual([firstArtifact, secondArtifact]);
    expect(receipt.items.filter((item) => item.target === "artifact_file")).toHaveLength(2);
    expect(receipt.items.filter((item) => item.target === "artifact_metadata")).toHaveLength(2);
  });

  it("keeps a pending tombstone until a busy WAL purge can be retried", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codeflow-delete-purge-"));
    cleanupDirectories.push(directory);
    const databasePath = path.join(directory, "storage.sqlite");
    const storage = new SqliteStorageDatabase(databasePath, {
      clock: { utcNow: () => NOW, monotonicNowMs: () => 0 },
      busyTimeoutMs: 1,
    });
    openDatabases.push(storage);
    const input = await createSession(storage);
    using reader = new DatabaseSync(databasePath, { timeout: 1 });
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT goal FROM sessions WHERE session_id = ?")
      .get(input.session.sessionId)).toEqual({ goal: input.session.goal });
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "missing"),
      referenceHashKey: HASH_KEY,
    });

    await expect(service.delete(input.session.sessionId)).rejects.toMatchObject({
      details: { category: "physical_purge_pending", retryable: true },
    });
    expect(count(storage, "sessions", "session_id", input.session.sessionId)).toBe(0);
    expect(storage.database.prepare(`
SELECT purge_state FROM deleted_session_tombstones`).get()).toEqual({ purge_state: "pending" });

    const inspectionOpen = new SqliteStorageDatabase(databasePath, {
      clock: { utcNow: () => NOW, monotonicNowMs: () => 0 },
      busyTimeoutMs: 1,
    });
    openDatabases.push(inspectionOpen);
    expect(inspectionOpen.database.prepare(`
SELECT purge_state FROM deleted_session_tombstones`).get()).toEqual({ purge_state: "pending" });
    inspectionOpen.close();

    reader.exec("ROLLBACK");
    reader.close();
    storage.close();

    const reopened = new SqliteStorageDatabase(databasePath, {
      clock: { utcNow: () => NOW, monotonicNowMs: () => 0 },
      busyTimeoutMs: 1,
    });
    openDatabases.push(reopened);
    expect(reopened.database.prepare(`
SELECT purge_state, purge_error_json FROM deleted_session_tombstones`).get()).toEqual({
      purge_state: "complete",
      purge_error_json: null,
    });

    const resumed = new SessionDeletionService(reopened, {
      artifactFileDeleter: stubFileDeleter(async () => "missing"),
      referenceHashKey: HASH_KEY,
    });
    await expect(resumed.delete(input.session.sessionId)).resolves.toMatchObject({
      status: "complete",
      items: [],
    });
    expect(reopened.database.prepare(`
SELECT purge_state, purge_error_json FROM deleted_session_tombstones`).get()).toEqual({
      purge_state: "complete",
      purge_error_json: null,
    });
  }, 15_000);

  it("fails without creating a receipt for an unknown Session", async () => {
    const storage = createDatabase();
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: stubFileDeleter(async () => "missing"),
      referenceHashKey: HASH_KEY,
    });

    await expect(service.delete(randomUUID())).rejects.toMatchObject({
      details: { category: "session_not_found" },
    });
    expect(storage.database.prepare("SELECT COUNT(*) AS count FROM delete_receipts").get()).toEqual({
      count: 0,
    });
  });
});

function stubFileDeleter(
  deleteArtifactFile: ArtifactFileDeleter["deleteArtifactFile"],
): ArtifactFileDeleter {
  return {
    deleteArtifactFile,
    finalizeSessionDirectory: async () => "missing",
  };
}

const noDeletedSessions = {
  hasDeletedSessionIdentity: () => false,
} as const;

function createDatabase(): SqliteStorageDatabase {
  const storage = new SqliteStorageDatabase(":memory:", {
    clock: { utcNow: () => NOW, monotonicNowMs: () => 0 },
  });
  openDatabases.push(storage);
  return storage;
}

async function createSession(storage: SqliteStorageDatabase): Promise<CreateSessionBundle> {
  const input = bundle();
  await new SqliteSessionRepository(storage, {
    deletedSessionIdentity: noDeletedSessions,
  }).create(input);
  return input;
}

function bundle(overrides: {
  workspaceId?: StableId;
  workspacePath?: string;
  workspaceFingerprint?: string;
  workspaceCreatedAt?: string;
} = {}): CreateSessionBundle {
  const sessionId = randomUUID();
  const workspaceId = overrides.workspaceId ?? randomUUID();
  const taskId = randomUUID();
  const goal = "Delete this Session";
  const normalizedPath = overrides.workspacePath ?? path.resolve("C:/workspace", workspaceId);
  const createdEvent = createAgentEvent({
    sessionId,
    taskId,
    actorId: "agent:primary",
    sequence: 0,
    type: "session.created",
    context: createEventContext({
      workspacePath: normalizedPath,
      configVersion: "config:v1",
    }),
    payload: { goal },
    occurredAt: NOW,
  });
  return {
    session: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId,
      workspace: {
        schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
        workspaceId,
        root: { normalizedPath, displayPath: normalizedPath },
        fingerprint: overrides.workspaceFingerprint ?? `fingerprint:${workspaceId}`,
        createdAt: overrides.workspaceCreatedAt ?? NOW,
      },
      goal,
      createdAt: NOW,
      expiresAt: null,
      configVersion: "config:v1",
      toolCatalogHash: `sha256:${"a".repeat(64)}`,
    },
    rootTask: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      taskId,
      actorId: "agent:primary",
      title: goal,
      createdAt: NOW,
    },
    createdEvent,
  };
}

function insertArtifact(storage: SqliteStorageDatabase, sessionId: StableId): StableId {
  const artifactId = randomUUID();
  storage.database
    .prepare(`
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
      `sha256:${"0".repeat(64)}`,
      NOW,
      NOW,
    );
  return artifactId;
}

function insertApproval(storage: SqliteStorageDatabase, sessionId: StableId): StableId {
  const approvalId = randomUUID();
  storage.database
    .prepare(`
INSERT INTO approvals(
  approval_id, session_id, schema_version, tool_name, operation_hash,
  decision, expires_at, decided_at
) VALUES (?, ?, ?, 'write', 'sha256:operation', 'approved', ?, ?)`)
    .run(approvalId, sessionId, STORAGE_RECORD_SCHEMA_VERSION, NOW, NOW);
  return approvalId;
}

function insertUsage(storage: SqliteStorageDatabase, sessionId: StableId): StableId {
  const usageId = randomUUID();
  storage.database
    .prepare(`
INSERT INTO usage_entries(usage_id, session_id, schema_version, entry_json, occurred_at)
VALUES (?, ?, ?, '{}', ?)`)
    .run(usageId, sessionId, STORAGE_RECORD_SCHEMA_VERSION, NOW);
  return usageId;
}

function count(
  storage: SqliteStorageDatabase,
  table: string,
  identifier: string,
  id: string,
): number {
  const row = storage.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${identifier} = ?`)
    .get(id);
  if (typeof row?.count !== "number") throw new TypeError("Invalid count result.");
  return row.count;
}
