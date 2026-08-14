import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext, type AgentEvent } from "../src/events/agent-event.js";
import { InMemoryEventStore } from "../src/events/event-store.js";
import type { StableId } from "../src/shared/contracts.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type CreateSessionBundle,
} from "../src/storage/contracts.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteEventStore } from "../src/storage/sqlite/sqlite-event-store.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";
import type { EventStoreContractHarness } from "./event-store-contract.js";

const openDatabases: SqliteStorageDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe.each([
  ["memory", memoryHarness],
  ["sqlite", sqliteHarness],
] as const)("EventStore contract: %s", (_provider, createHarness) => {
  it("appends exactly once, reads incrementally, and notifies only after insertion", async () => {
    const harness = createHarness();
    const first = harness.createEvent(0, "session.created");
    const second = harness.createEvent(1, "session.started");
    const observed: string[] = [];
    const unsubscribe = harness.store.subscribe(first.sessionId, (event) => {
      observed.push(event.type);
    });

    await expect(harness.append(first)).resolves.toBe("inserted");
    await expect(harness.store.append(first)).resolves.toBe("duplicate");
    await expect(harness.append(second)).resolves.toBe("inserted");
    unsubscribe();

    await expect(harness.store.list(first.sessionId)).resolves.toEqual([first, second]);
    await expect(harness.store.list(first.sessionId, 0)).resolves.toEqual([second]);
    await expect(harness.store.latestSequence(first.sessionId)).resolves.toBe(1);
    expect(observed).toEqual(
      harness.initialAppendNotifies
        ? ["session.created", "session.started"]
        : ["session.started"],
    );
    harness.close();
  });

  it("shares exact ID conflict, sequence conflict, and visible gap semantics", async () => {
    const harness = createHarness();
    const first = harness.createEvent(0, "session.created");
    const gapped = harness.createEvent(2, "session.started");
    await harness.append(first);

    await expect(harness.store.append({ ...first, payload: { goal: "different" } }))
      .rejects.toMatchObject({ details: { category: "event_id_conflict" } });
    await expect(harness.append(harness.createEvent(0, "session.started")))
      .rejects.toMatchObject({ details: { category: "event_sequence_conflict" } });
    await expect(harness.append(gapped)).resolves.toBe("inserted");
    await expect(harness.store.latestSequence(first.sessionId)).resolves.toBe(2);
    harness.close();
  });

  it("isolates listener failures from the durable append", async () => {
    const harness = createHarness();
    const first = harness.createEvent(0, "session.created");
    harness.store.subscribe(first.sessionId, () => {
      throw new Error("listener failed");
    });
    await expect(harness.append(first)).resolves.toBe("inserted");
    await expect(harness.store.list(first.sessionId)).resolves.toEqual([first]);
    harness.close();
  });

  it("shares stable validation errors at reader and subscriber boundaries", async () => {
    const harness = createHarness();
    const invalidSessionId = "not-a-session-id" as StableId;
    await expect(harness.store.list(invalidSessionId)).rejects.toMatchObject({
      details: { category: "invalid_session_id" },
    });
    await expect(harness.store.latestSequence(invalidSessionId)).rejects.toMatchObject({
      details: { category: "invalid_session_id" },
    });
    await expect(harness.store.list(harness.createEvent(0, "session.created").sessionId, -2))
      .rejects.toMatchObject({ details: { category: "event_cursor_invalid" } });
    try {
      harness.store.subscribe(invalidSessionId, () => undefined);
      throw new Error("Expected subscribe validation to fail.");
    } catch (error: unknown) {
      expect(error).toMatchObject({ details: { category: "invalid_session_id" } });
    }
    harness.close();
  });
});

describe("SqliteEventStore persistence", () => {
  it("round-trips every AgentEvent field and fails closed on canonical JSON tampering", async () => {
    const harness = sqliteHarness();
    const event = harness.createEvent(0, "session.created", {
      actorId: "agent:specialist",
      parentTaskId: null,
      context: createEventContext({
        workspacePath: harness.createEvent(0, "session.created").context.workspacePath,
        codeVersion: "git:abc123",
        diffHash: "sha256:diff",
        configVersion: "config:v1",
        operation: {
          kind: "control",
          name: "create-session",
          status: "completed",
          durationMs: 1,
          operationHash: "sha256:operation",
        },
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedTokens: 3,
          costUsd: 0.01,
          providerUsage: { provider: "fixture" },
        },
        budget: {
          usage: { steps: 1, toolCalls: 0, durationMs: 1, costUsd: 0.01 },
          limits: { maxSteps: 10, maxToolCalls: 10, maxDurationMs: 1000, maxCostUsd: 1 },
        },
      }),
    });
    await harness.append(event);
    await expect(harness.store.list(event.sessionId)).resolves.toEqual([event]);

    const sqlite = harness as ReturnType<typeof sqliteHarness>;
    sqlite.database.database
      .prepare("UPDATE agent_events SET event_json = ? WHERE event_id = ?")
      .run("{}", event.eventId);
    await expect(harness.store.list(event.sessionId)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
    harness.close();
  });

  it("rolls back event and watermark at the injected transaction boundary", async () => {
    const base = sqliteHarness();
    const first = base.createEvent(0, "session.created");
    await base.append(first);
    const second = base.createEvent(1, "session.started");
    const faulting = new SqliteEventStore(base.database, {
      faultInjector: { hit: () => { throw new Error("injected crash"); } },
    });
    await expect(faulting.append(second)).rejects.toMatchObject({
      details: { category: "storage_operation_failed" },
    });
    await expect(base.store.list(first.sessionId)).resolves.toEqual([first]);
    await expect(base.store.latestSequence(first.sessionId)).resolves.toBe(0);
    expect(base.database.database.prepare("SELECT last_sequence FROM sessions WHERE session_id = ?")
      .get(first.sessionId)?.last_sequence).toBe(0);
    base.close();
  });

  it("serializes concurrent appends without letting one call roll back another transaction", async () => {
    const harness = sqliteHarness();
    const initial = harness.createEvent(0, "session.created");
    await harness.append(initial);
    const first = harness.createEvent(1, "session.started");
    const second = harness.createEvent(2, "session.started");

    const results = await Promise.allSettled([
      harness.store.append(first),
      harness.store.append(second),
    ]);

    expect(results).toEqual([
      { status: "fulfilled", value: "inserted" },
      { status: "fulfilled", value: "inserted" },
    ]);
    await expect(harness.store.list(initial.sessionId)).resolves.toEqual([initial, first, second]);
    harness.close();
  });

  it("fails closed when duplicate indexes or the Session watermark are tampered", async () => {
    const indexed = sqliteHarness();
    const first = indexed.createEvent(0, "session.created");
    await indexed.append(first);
    indexed.database.database
      .prepare("UPDATE agent_events SET event_type = 'session.started' WHERE event_id = ?")
      .run(first.eventId);
    await expect(indexed.store.append(first)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
    indexed.close();

    const watermarked = sqliteHarness();
    const second = watermarked.createEvent(0, "session.created");
    await watermarked.append(second);
    watermarked.database.database
      .prepare("UPDATE sessions SET last_sequence = 7 WHERE session_id = ?")
      .run(second.sessionId);
    await expect(watermarked.store.append(second)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
    watermarked.close();
  });
});

interface TestIdentity {
  readonly sessionId: StableId;
  readonly taskId: StableId;
  readonly workspaceId: StableId;
  readonly workspacePath: string;
}

function identity(): TestIdentity {
  const workspaceId = randomUUID();
  return {
    sessionId: randomUUID(),
    taskId: randomUUID(),
    workspaceId,
    workspacePath: path.resolve("C:/workspace", workspaceId),
  };
}

function createTestEvent(
  ids: TestIdentity,
  sequence: number,
  type: "session.created" | "session.started",
  overrides: Partial<AgentEvent> = {},
): AgentEvent {
  const generated = createAgentEvent({
    sessionId: ids.sessionId,
    taskId: ids.taskId,
    sequence,
    type,
    context: createEventContext({ workspacePath: ids.workspacePath, configVersion: "config:v1" }),
    payload: type === "session.created" ? { goal: "contract" } : {},
    occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
  });
  return { ...generated, ...overrides };
}

function memoryHarness(): EventStoreContractHarness {
  const ids = identity();
  const store = new InMemoryEventStore();
  return {
    store,
    initialAppendNotifies: true,
    append: (event) => store.append(event),
    createEvent: (sequence, type, overrides) => createTestEvent(ids, sequence, type, overrides),
    close: () => undefined,
  };
}

function sqliteHarness(): EventStoreContractHarness & { readonly database: SqliteStorageDatabase } {
  const ids = identity();
  const database = new SqliteStorageDatabase(":memory:", {
    clock: { utcNow: () => "2026-08-12T12:00:00.000Z", monotonicNowMs: () => 0 },
  });
  openDatabases.push(database);
  const sessions = new SqliteSessionRepository(database, {
    deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
  });
  const store = new SqliteEventStore(database);
  let created = false;
  const createEvent = (sequence: number, type: "session.created" | "session.started", overrides?: Partial<AgentEvent>) =>
    createTestEvent(ids, sequence, type, overrides);
  return {
    database,
    store,
    initialAppendNotifies: false,
    createEvent,
    append: async (event) => {
      if (created) return store.append(event);
      if (event.type !== "session.created" || event.sequence !== 0) {
        const initial = createEvent(0, "session.created");
        await sessions.create(bundle(ids, initial));
        created = true;
        return store.append(event);
      }
      await sessions.create(bundle(ids, event));
      created = true;
      return "inserted";
    },
    close: () => database.close(),
  };
}

function bundle(ids: TestIdentity, event: AgentEvent): CreateSessionBundle {
  return {
    session: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId: ids.sessionId,
      workspace: {
        schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
        workspaceId: ids.workspaceId,
        root: { normalizedPath: ids.workspacePath, displayPath: ids.workspacePath },
        fingerprint: `fingerprint:${ids.workspaceId}`,
        createdAt: event.occurredAt,
      },
      goal: "contract",
      createdAt: event.occurredAt,
      expiresAt: null,
      configVersion: "config:v1",
      toolCatalogHash: `sha256:${"a".repeat(64)}`,
    },
    rootTask: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      taskId: ids.taskId,
      actorId: event.actorId,
      title: "contract",
      createdAt: event.occurredAt,
    },
    createdEvent: event,
  };
}
