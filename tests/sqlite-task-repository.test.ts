import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type CreateSessionBundle,
  type TaskRecord,
} from "../src/storage/contracts.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";
import { SqliteTaskRepository } from "../src/storage/sqlite/sqlite-task-repository.js";

const databases: SqliteStorageDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SqliteTaskRepository", () => {
  it("creates, reads and lists child Tasks with exact idempotency", async () => {
    const { sessions, tasks } = repositories();
    const session = sessionBundle();
    await sessions.create(session);
    const child = task({
      sessionId: session.session.sessionId,
      parentTaskId: session.rootTask.taskId,
      title: "Inspect source",
    });

    await expect(tasks.create(child)).resolves.toBe("inserted");
    await expect(tasks.create(child)).resolves.toBe("duplicate");
    await expect(tasks.get(child.taskId)).resolves.toEqual(child);
    await expect(tasks.list(session.session.sessionId)).resolves.toEqual([
      {
        ...session.rootTask,
        sessionId: session.session.sessionId,
        parentTaskId: null,
      },
      child,
    ]);
  });

  it("rejects a reused Task ID with different contents without overwriting it", async () => {
    const { sessions, tasks } = repositories();
    const session = sessionBundle();
    await sessions.create(session);
    const original = task({
      sessionId: session.session.sessionId,
      parentTaskId: session.rootTask.taskId,
      title: "Original",
    });
    await tasks.create(original);

    await expect(tasks.create({ ...original, title: "Changed" })).rejects.toMatchObject({
      details: { category: "task_id_conflict" },
    });
    await expect(tasks.get(original.taskId)).resolves.toEqual(original);
  });

  it("detects durable Task tampering instead of trusting only its stored hash", async () => {
    const { database, sessions, tasks } = repositories();
    const session = sessionBundle();
    await sessions.create(session);
    const child = task({
      sessionId: session.session.sessionId,
      parentTaskId: session.rootTask.taskId,
      title: "Untampered",
    });
    await tasks.create(child);
    database.database.prepare("UPDATE tasks SET title = ? WHERE task_id = ?")
      .run("Tampered", child.taskId);

    await expect(tasks.create(child)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
    await expect(tasks.get(child.taskId)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
    await expect(tasks.list(session.session.sessionId)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
  });

  it("requires an existing parent in the same Session", async () => {
    const { sessions, tasks } = repositories();
    const first = sessionBundle();
    const second = sessionBundle();
    await sessions.create(first);
    await sessions.create(second);

    await expect(tasks.create(task({
      sessionId: first.session.sessionId,
      parentTaskId: randomUUID(),
    }))).rejects.toMatchObject({ details: { category: "parent_task_not_found" } });

    await expect(tasks.create(task({
      sessionId: first.session.sessionId,
      parentTaskId: second.rootTask.taskId,
    }))).rejects.toMatchObject({ details: { category: "cross_session_parent_task" } });
  });

  it("does not permit a second root or a self-parenting Task", async () => {
    const { sessions, tasks } = repositories();
    const session = sessionBundle();
    await sessions.create(session);
    const taskId = randomUUID();

    await expect(tasks.create(task({
      taskId,
      sessionId: session.session.sessionId,
      parentTaskId: null,
    }))).rejects.toMatchObject({ details: { category: "invalid_task_parent" } });
    await expect(tasks.create(task({
      taskId,
      sessionId: session.session.sessionId,
      parentTaskId: taskId,
    }))).rejects.toMatchObject({ details: { category: "invalid_task_parent" } });
  });

  it("requires an active existing Session", async () => {
    const { database, sessions, tasks } = repositories();
    const missingSessionId = randomUUID();
    await expect(tasks.create(task({
      sessionId: missingSessionId,
      parentTaskId: randomUUID(),
    }))).rejects.toMatchObject({ details: { category: "session_not_found" } });

    const session = sessionBundle();
    await sessions.create(session);
    database.database
      .prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
      .run(session.session.sessionId);
    await expect(tasks.create(task({
      sessionId: session.session.sessionId,
      parentTaskId: session.rootTask.taskId,
    }))).rejects.toMatchObject({ details: { category: "session_deleting" } });
  });

  it("returns an empty list for an unknown Session without fabricating it", async () => {
    const { tasks } = repositories();
    await expect(tasks.get(randomUUID())).resolves.toBeNull();
    await expect(tasks.list(randomUUID())).resolves.toEqual([]);
  });
});

function repositories() {
  const database = new SqliteStorageDatabase(":memory:", {
    clock: { utcNow: () => "2026-08-12T00:00:00.000Z", monotonicNowMs: () => 0 },
  });
  databases.push(database);
  return {
    database,
    sessions: new SqliteSessionRepository(database, {
      deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
    }),
    tasks: new SqliteTaskRepository(database),
  };
}

function task(overrides: {
  taskId?: string;
  sessionId: string;
  parentTaskId: string | null;
  title?: string;
}): TaskRecord {
  return {
    schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
    taskId: overrides.taskId ?? randomUUID(),
    sessionId: overrides.sessionId,
    parentTaskId: overrides.parentTaskId,
    actorId: "agent:primary",
    title: overrides.title ?? "Child Task",
    createdAt: "2026-08-12T01:00:00.000Z",
  };
}

function sessionBundle(): CreateSessionBundle {
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const goal = `Session ${sessionId}`;
  const createdAt = "2026-08-12T00:00:00.000Z";
  const normalizedPath = path.resolve("C:/workspace", workspaceId);
  return {
    session: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId,
      workspace: {
        schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
        workspaceId,
        root: { normalizedPath, displayPath: normalizedPath },
        fingerprint: `fingerprint:${workspaceId}`,
        createdAt,
      },
      goal,
      createdAt,
      expiresAt: null,
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
    createdEvent: createAgentEvent({
      sessionId,
      taskId,
      actorId: "agent:primary",
      sequence: 0,
      type: "session.created",
      context: createEventContext({ workspacePath: normalizedPath, configVersion: "config:v1" }),
      payload: { goal },
      occurredAt: createdAt,
    }),
  };
}
