import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { canonicalJson } from "../src/shared/json.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type CreateSessionBundle,
  type SessionFilter,
} from "../src/storage/contracts.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import {
  createSessionListCursor,
  SqliteSessionRepository,
} from "../src/storage/sqlite/sqlite-session-repository.js";

const openDatabases: SqliteStorageDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe("SqliteSessionRepository", () => {
  it("atomically creates a Workspace, Session, root Task and initial event", async () => {
    const { database, repository } = createRepository();
    const input = bundle({ goal: "Implement storage" });

    await expect(repository.create(input)).resolves.toBe("inserted");
    await expect(repository.create(input)).resolves.toBe("duplicate");

    await expect(repository.get(input.session.sessionId)).resolves.toEqual({
      ...input.session,
      lifecycle: "CREATED",
      updatedAt: input.session.createdAt,
      pinned: false,
      lastSequence: 0,
    });
    expect(
      database.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE session_id = ?")
        .get(input.session.sessionId)?.count,
    ).toBe(1);
    expect(
      database.database.prepare("SELECT event_json FROM agent_events WHERE session_id = ?")
        .get(input.session.sessionId)?.event_json,
    ).toBe(canonicalJson(input.createdEvent));
  });

  it("rejects a reused Session ID with a different exact creation bundle", async () => {
    const { repository } = createRepository();
    const input = bundle({ goal: "Original goal" });
    await repository.create(input);
    const different = bundle({
      sessionId: input.session.sessionId,
      workspaceId: input.session.workspace.workspaceId,
      taskId: input.rootTask.taskId,
      goal: "Different goal",
      eventId: input.createdEvent.eventId,
      traceId: input.createdEvent.traceId,
      spanId: input.createdEvent.spanId,
    });

    await expect(repository.create(different)).rejects.toMatchObject({
      name: "StorageError",
      details: { category: "session_id_conflict" },
    });
    await expect(repository.get(input.session.sessionId)).resolves.toMatchObject({
      goal: "Original goal",
    });
  });

  it("detects tampering instead of trusting only the stored creation hash", async () => {
    const { database, repository } = createRepository();
    const input = bundle({ goal: "Untampered" });
    await repository.create(input);
    database.database
      .prepare("UPDATE sessions SET goal = ? WHERE session_id = ?")
      .run("Tampered", input.session.sessionId);

    await expect(repository.create(input)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
  });

  it("rolls back every record when root Task identity conflicts", async () => {
    const { database, repository } = createRepository();
    const first = bundle({ goal: "First" });
    await repository.create(first);
    const second = bundle({ taskId: first.rootTask.taskId, goal: "Second" });

    await expect(repository.create(second)).rejects.toMatchObject({ name: "StorageError" });
    await expect(repository.get(second.session.sessionId)).resolves.toBeNull();
    expect(
      database.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count,
    ).toBe(1);
  });

  it("derives lifecycle exclusively from immutable events", async () => {
    const { database, repository } = createRepository();
    const input = bundle({ goal: "Projection" });
    await repository.create(input);

    await expect(repository.get(input.session.sessionId)).resolves.toMatchObject({
      lifecycle: "CREATED",
    });
    expect(
      database.database.prepare("PRAGMA table_info(sessions)").all()
        .some((column) => column.name === "lifecycle"),
    ).toBe(false);
  });

  it("lists by filters with a cursor bound to the exact filter", async () => {
    const { repository } = createRepository();
    const sharedWorkspaceId = randomUUID();
    const first = bundle({
      workspaceId: sharedWorkspaceId,
      createdAt: "2026-08-10T00:00:00.000Z",
      goal: "First",
    });
    const second = bundle({
      workspaceId: sharedWorkspaceId,
      workspaceCreatedAt: first.session.workspace.createdAt,
      workspaceFingerprint: first.session.workspace.fingerprint,
      createdAt: "2026-08-11T00:00:00.000Z",
      goal: "Second",
    });
    await repository.create(first);
    await repository.create(second);
    await repository.setPinned(second.session.sessionId, true);

    const baseFilter = { workspaceId: sharedWorkspaceId, pinned: true, limit: 1 } satisfies SessionFilter;
    const page = await repository.list(baseFilter);
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ sessionId: second.session.sessionId, pinned: true });

    const cursor = createSessionListCursor(baseFilter, page[0]!);
    await expect(repository.list({ ...baseFilter, cursor })).resolves.toEqual([]);
    await expect(repository.list({ ...baseFilter, pinned: false, cursor })).rejects.toMatchObject({
      details: { category: "invalid_session_cursor" },
    });
  });

  it("pins with an injected Clock and clears expiry", async () => {
    const now = "2026-08-12T12:00:00.000Z";
    const { repository } = createRepository(now);
    const input = bundle({ expiresAt: "2026-09-01T00:00:00.000Z" });
    await repository.create(input);

    await repository.setPinned(input.session.sessionId, true);
    await expect(repository.get(input.session.sessionId)).resolves.toMatchObject({
      pinned: true,
      expiresAt: null,
      updatedAt: now,
    });
    await expect(repository.setPinned(randomUUID(), true)).rejects.toMatchObject({
      details: { category: "session_not_found" },
    });
  });

  it("requires and stores a fresh policy expiry when unpinning", async () => {
    const { repository } = createRepository("2026-08-12T12:00:00.000Z");
    const input = bundle({ expiresAt: "2026-08-20T00:00:00.000Z" });
    await repository.create(input);
    await repository.setPinned(input.session.sessionId, true);

    await expect(repository.setPinned(input.session.sessionId, false)).rejects.toMatchObject({
      details: { category: "retention_expiry_required" },
    });
    const expiresAt = "2026-09-11T12:00:00.000Z";
    await repository.setPinned(input.session.sessionId, false, expiresAt);
    await expect(repository.get(input.session.sessionId)).resolves.toMatchObject({
      pinned: false,
      expiresAt,
    });
  });

  it("fails closed when deletion is attempted without the Artifact coordinator", async () => {
    const { repository } = createRepository();
    const input = bundle();
    await repository.create(input);

    await expect(repository.delete(input.session.sessionId)).rejects.toMatchObject({
      details: { category: "session_delete_requires_coordinator" },
    });
    await expect(repository.get(input.session.sessionId)).resolves.not.toBeNull();
  });
});

function createRepository(now: string = "2026-08-12T00:00:00.000Z") {
  const clock = {
    utcNow: () => now,
    monotonicNowMs: () => 0,
  } as const;
  const database = new SqliteStorageDatabase(":memory:", { clock });
  openDatabases.push(database);
  return {
    database,
    repository: new SqliteSessionRepository(database, {
      deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
    }),
  };
}

function bundle(overrides: {
  sessionId?: string;
  workspaceId?: string;
  taskId?: string;
  eventId?: string;
  traceId?: string;
  spanId?: string;
  goal?: string;
  createdAt?: string;
  workspaceCreatedAt?: string;
  workspaceFingerprint?: string;
  expiresAt?: string | null;
} = {}): CreateSessionBundle {
  const sessionId = overrides.sessionId ?? randomUUID();
  const workspaceId = overrides.workspaceId ?? randomUUID();
  const taskId = overrides.taskId ?? randomUUID();
  const createdAt = overrides.createdAt ?? "2026-08-10T00:00:00.000Z";
  const goal = overrides.goal ?? "Test Session";
  const normalizedPath = path.resolve("C:/workspace", workspaceId);
  const createdEvent = createAgentEvent({
    sessionId,
    taskId,
    actorId: "agent:primary",
    ...(overrides.traceId === undefined ? {} : { traceId: overrides.traceId }),
    ...(overrides.spanId === undefined ? {} : { spanId: overrides.spanId }),
    sequence: 0,
    type: "session.created",
    context: createEventContext({
      workspacePath: normalizedPath,
      configVersion: "config:v1",
    }),
    payload: { goal },
    occurredAt: createdAt,
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
        createdAt: overrides.workspaceCreatedAt ?? createdAt,
      },
      goal,
      createdAt,
      expiresAt: overrides.expiresAt ?? null,
      configVersion: "config:v1",
      toolCatalogHash: `sha256:${"a".repeat(64)}`,
    },
    rootTask: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      taskId,
      actorId: "agent:primary",
      title: goal,
      createdAt,
    },
    createdEvent: overrides.eventId ? { ...createdEvent, eventId: overrides.eventId } : createdEvent,
  };
}
