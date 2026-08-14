import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import type { ArtifactReference, Clock } from "../src/shared/contracts.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type CreateSessionBundle,
} from "../src/storage/contracts.js";
import {
  StorageRecoveryInspector,
  type ArtifactPhysicalState,
  type ArtifactRecoveryVerifier,
} from "../src/storage/storage-recovery-inspector.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteEventStore } from "../src/storage/sqlite/sqlite-event-store.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";

const NOW = "2026-08-12T12:00:00.000Z";
const clock: Clock = {
  utcNow: () => NOW,
  monotonicNowMs: () => 0,
};
const openDatabases: SqliteStorageDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0).reverse()) database.close();
});

describe("StorageRecoveryInspector", () => {
  it("derives a healthy lifecycle from canonical events and declares journal capability unavailable", async () => {
    const testContext = await createDefaultFixture();
    await testContext.events.append(startedEvent(testContext.bundle, 1));

    const report = await testContext.inspector.inspect(testContext.bundle.session.sessionId);

    expect(report).toMatchObject({
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId: testContext.bundle.session.sessionId,
      lifecycle: "RUNNING",
      lastSequence: 1,
      lastStableSequence: 1,
      traceComplete: true,
      firstGap: null,
      traceError: null,
      missingArtifacts: [],
      corruptArtifacts: [],
      unreadyArtifacts: [],
      deletion: {
        sessionDeletionState: "active",
        receiptId: null,
        receiptStatus: "none",
        pendingItems: 0,
        failedItems: 0,
      },
      externalOperations: {
        capability: "unavailable",
        operations: [],
      },
    });
    expect(report.externalOperations.reason).toContain("C08/C11 durable operation journals");
  });

  it("reports a gap while preserving only the contiguous stable lifecycle prefix", async () => {
    const testContext = await createDefaultFixture();
    await testContext.events.append(startedEvent(testContext.bundle, 2));

    const report = await testContext.inspector.inspect(testContext.bundle.session.sessionId);

    expect(report).toMatchObject({
      lifecycle: "CREATED",
      lastSequence: 2,
      lastStableSequence: 0,
      traceComplete: false,
      firstGap: 1,
      traceError: { category: "trace_incomplete" },
    });
  });

  it("fails the trace closed when canonical event JSON or its hash is corrupt", async () => {
    const testContext = await createDefaultFixture();
    testContext.database.database
      .prepare("UPDATE agent_events SET event_hash = ? WHERE session_id = ?")
      .run(`sha256:${"f".repeat(64)}`, testContext.bundle.session.sessionId);

    const report = await testContext.inspector.inspect(testContext.bundle.session.sessionId);

    expect(report).toMatchObject({
      lifecycle: null,
      lastSequence: 0,
      lastStableSequence: null,
      traceComplete: false,
      firstGap: 0,
      traceError: { category: "storage_corrupt" },
    });
  });

  it("reports missing, hash-mismatched, metadata-corrupt and staged Artifacts by reference", async () => {
    const physicalStates = new Map<string, ArtifactPhysicalState>();
    const verifier = verifierFrom(physicalStates);
    const testContext = await createFixture(verifier);
    const missing = insertArtifact(testContext.database, testContext.bundle.session.sessionId, "ready");
    const mismatched = insertArtifact(testContext.database, testContext.bundle.session.sessionId, "ready");
    const metadataCorrupt = insertArtifact(testContext.database, testContext.bundle.session.sessionId, "corrupt");
    const staged = insertArtifact(testContext.database, testContext.bundle.session.sessionId, "staged");
    physicalStates.set(missing.artifactId, "missing");
    physicalStates.set(mismatched.artifactId, "corrupt");

    const report = await testContext.inspector.inspect(testContext.bundle.session.sessionId);

    expect(report.missingArtifacts).toEqual([{ reference: missing, reason: "file_missing" }]);
    expect(report.corruptArtifacts).toEqual([
      { reference: mismatched, reason: "hash_mismatch" },
      { reference: metadataCorrupt, reason: "metadata_marked_corrupt" },
    ].sort(byArtifactId));
    expect(report.unreadyArtifacts).toEqual([
      { reference: staged, reason: "commit_incomplete" },
    ]);
    expect(verifier.inspect).toHaveBeenCalledTimes(2);
  });

  it("reports an incomplete deletion receipt without inventing external operations", async () => {
    const testContext = await createDefaultFixture();
    const sessionId = testContext.bundle.session.sessionId;
    const receiptId = randomUUID();
    testContext.database.database
      .prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
      .run(sessionId);
    testContext.database.database.prepare(`
INSERT INTO delete_receipts(
  receipt_id, schema_version, session_id, status, started_at, completed_at, error_json
) VALUES (?, 1, ?, 'failed', ?, NULL, ?)`)
      .run(receiptId, sessionId, NOW, JSON.stringify({
        category: "artifact_session_directory_not_empty",
        message: "unknown directory entry",
        retryable: false,
        sideEffectStatus: "none",
        recovery: "Inspect the Artifact Session directory.",
      }));
    testContext.database.database.prepare(`
INSERT INTO delete_receipt_items(
  receipt_id, ordinal, target, reference_hash, status, error_json
) VALUES (?, 0, 'artifact_file', ?, 'pending', NULL),
         (?, 1, 'artifact_metadata', ?, 'failed', ?),
         (?, 2, 'session', ?, 'pending', NULL)`)
      .run(
        receiptId,
        `sha256:${"1".repeat(64)}`,
        receiptId,
        `sha256:${"2".repeat(64)}`,
        JSON.stringify({
          category: "deletion_reference_lost",
          message: "Artifact metadata is unavailable.",
          retryable: false,
          sideEffectStatus: "unknown",
          recovery: "Restore the Artifact metadata.",
        }),
        receiptId,
        `sha256:${"3".repeat(64)}`,
      );

    const report = await testContext.inspector.inspect(sessionId);

    expect(report.deletion).toEqual({
      sessionDeletionState: "deleting",
      receiptId,
      receiptStatus: "failed",
      pendingItems: 2,
      failedItems: 1,
      errors: [
        expect.objectContaining({ category: "artifact_session_directory_not_empty" }),
        expect.objectContaining({ category: "deletion_reference_lost" }),
      ],
    });
    expect(report.externalOperations).toMatchObject({ capability: "unavailable", operations: [] });
  });

  it("marks a deleting Session with no durable receipt as an inconsistent deletion", async () => {
    const testContext = await createDefaultFixture();
    testContext.database.database
      .prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
      .run(testContext.bundle.session.sessionId);

    await expect(testContext.inspector.inspect(testContext.bundle.session.sessionId)).resolves.toMatchObject({
      deletion: {
        sessionDeletionState: "deleting",
        receiptId: null,
        receiptStatus: "missing",
      },
    });
  });

  it("surfaces pending physical purge tombstones in global and Session recovery reports", async () => {
    const testContext = await createDefaultFixture();
    const receiptId = randomUUID();
    const purgeError = {
      category: "physical_purge_pending",
      message: "reader holds the WAL",
      retryable: true,
      sideEffectStatus: "none" as const,
      recovery: "Close the reader and retry.",
    };
    testContext.database.database.prepare(`
INSERT INTO deleted_session_tombstones(
  receipt_id, schema_version, session_id_hash, requested_at, completed_at,
  final_status, target_counts_json, purge_state, purge_error_json
) VALUES (?, 1, ?, ?, ?, 'complete', '{}', 'pending', ?)`)
      .run(
        receiptId,
        `sha256:${"4".repeat(64)}`,
        NOW,
        NOW,
        JSON.stringify(purgeError),
      );

    const expected = [{ receiptId, completedAt: NOW, error: purgeError }];
    expect(testContext.inspector.inspectPendingPhysicalPurges()).toEqual(expected);
    await expect(testContext.inspector.inspect(testContext.bundle.session.sessionId))
      .resolves.toMatchObject({ pendingPhysicalPurges: expected });
  });
});

async function createDefaultFixture() {
  return createFixture(verifierFrom(new Map()));
}

async function createFixture(verifier: ArtifactRecoveryVerifier) {
  const database = new SqliteStorageDatabase(":memory:", { clock });
  openDatabases.push(database);
  const sessions = new SqliteSessionRepository(database, {
    deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
  });
  const bundleValue = bundle();
  await sessions.create(bundleValue);
  return {
    database,
    bundle: bundleValue,
    events: new SqliteEventStore(database),
    inspector: new StorageRecoveryInspector(database, verifier),
  };
}

function bundle(): CreateSessionBundle {
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const goal = "Inspect recovery";
  const normalizedPath = path.resolve("C:/workspace", workspaceId);
  const createdEvent = createAgentEvent({
    sessionId,
    taskId,
    actorId: "agent:primary",
    sequence: 0,
    type: "session.created",
    context: createEventContext({ workspacePath: normalizedPath, configVersion: "config:v1" }),
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
        fingerprint: `fingerprint:${workspaceId}`,
        createdAt: NOW,
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

function startedEvent(bundleValue: CreateSessionBundle, sequence: number) {
  return createAgentEvent({
    sessionId: bundleValue.session.sessionId,
    taskId: bundleValue.rootTask.taskId,
    actorId: bundleValue.rootTask.actorId,
    traceId: bundleValue.createdEvent.traceId,
    sequence,
    type: "session.started",
    context: createEventContext({
      workspacePath: bundleValue.session.workspace.root.normalizedPath,
      configVersion: bundleValue.session.configVersion,
    }),
    occurredAt: NOW,
  });
}

function insertArtifact(
  database: SqliteStorageDatabase,
  sessionId: string,
  state: "staged" | "ready" | "corrupt",
): ArtifactReference {
  const artifactId = randomUUID();
  const reference: ArtifactReference = {
    artifactId,
    relativePath: `artifacts/${sessionId}/${artifactId}.bin`,
    mediaType: "application/octet-stream",
    byteLength: 7,
    sha256: `sha256:${artifactId.replaceAll("-", "").repeat(2)}`,
    sensitivity: "normal",
  };
  database.database.prepare(`
INSERT INTO artifacts(
  artifact_id, schema_version, session_id, state, staged_relative_path,
  ready_relative_path, media_type, byte_length, sha256, sensitivity,
  created_at, verified_at, error_json
) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
    .run(
      artifactId,
      sessionId,
      state,
      state === "staged" ? `artifacts/${sessionId}/.${artifactId}.tmp` : null,
      reference.relativePath,
      reference.mediaType,
      reference.byteLength,
      reference.sha256,
      reference.sensitivity,
      NOW,
      state === "corrupt" ? JSON.stringify({ category: "artifact_hash_mismatch" }) : null,
    );
  return reference;
}

function verifierFrom(states: Map<string, ArtifactPhysicalState>): ArtifactRecoveryVerifier & {
  inspect: ReturnType<typeof vi.fn>;
} {
  return {
    inspect: vi.fn(async (_sessionId: string, reference: ArtifactReference) =>
      states.get(reference.artifactId) ?? "ready"),
  };
}

function byArtifactId(
  left: { reference: ArtifactReference },
  right: { reference: ArtifactReference },
): number {
  return left.reference.artifactId.localeCompare(right.reference.artifactId);
}
