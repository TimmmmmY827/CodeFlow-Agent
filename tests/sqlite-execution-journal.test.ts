import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { reduceAgentEvents } from "../src/events/state-reducer.js";
import { budgetDeltaSchema, type BudgetPolicy } from "../src/policy/budget-contracts.js";
import { OPERATION_BINDING_VERSION, type OperationBinding } from "../src/policy/permission-contracts.js";
import { createOperationHash } from "../src/policy/operation-hash.js";
import type { Clock } from "../src/shared/contracts.js";
import { STORAGE_RECORD_SCHEMA_VERSION, type CreateSessionBundle } from "../src/storage/contracts.js";
import { SqliteBudgetLedger } from "../src/storage/sqlite/sqlite-budget-ledger.js";
import { SqliteApprovalRepository } from "../src/storage/sqlite/sqlite-approval-repository.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteEventStore } from "../src/storage/sqlite/sqlite-event-store.js";
import { SqliteExecutionJournal } from "../src/storage/sqlite/sqlite-execution-journal.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";

const NOW = "2026-08-15T00:00:00.000Z" as const;
const clock: Clock = { utcNow: () => NOW, monotonicNowMs: () => 0 };
const open: SqliteStorageDatabase[] = [];
const policy: BudgetPolicy = {
  limits: { maxSteps: 10, maxToolCalls: 10, maxDurationMs: 10_000, maxInputTokens: 10_000, maxOutputTokens: 10_000, maxCostUsd: 1, maxRetriesPerOperation: 2, maxNoProgressCycles: 2 },
  softLimitRatio: 0.8,
  countWaitingTime: false,
};

afterEach(() => {
  for (const storage of open.splice(0)) storage.close();
});

describe("SqliteExecutionJournal", () => {
  it("atomically reserves, records and settles a model attempt as replayable facts", async () => {
    const storage = createStorage();
    const bundle = createBundle();
    await sessionRepository(storage).create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId: bundle.session.sessionId, policy, pricingVersion: "pricing:test" });
    const journal = new SqliteExecutionJournal(storage, events, ledger);
    const identity = {
      sessionId: bundle.session.sessionId,
      taskId: bundle.rootTask.taskId,
      traceId: bundle.createdEvent.traceId,
      workspacePath: bundle.session.workspace.root.normalizedPath,
      codeVersion: "git:test",
      diffHash: `sha256:${"d".repeat(64)}`,
      configVersion: bundle.session.configVersion,
    } as const;

    await journal.append({ identity, type: "session.started" });
    const lease = await journal.begin({
      identity,
      kind: "model",
      name: "deepseek-v4-flash",
      operationHash: `sha256:${"1".repeat(64)}`,
      estimate: budgetDeltaSchema.parse({ steps: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01 }),
    });
    await journal.finish({
      lease,
      status: "completed",
      actual: budgetDeltaSchema.parse({ steps: 1, inputTokens: 80, outputTokens: 20, costUsd: 0.001 }),
      usage: { inputTokens: 80, outputTokens: 20, cachedTokens: 0, costUsd: 0.001, durationMs: 0, providerUsage: {} },
      sideEffectStatus: "none",
      payload: { responseId: "response-1", finishReason: "stop" },
    });

    const facts = await events.list(bundle.session.sessionId);
    expect(facts.map((event) => event.type)).toEqual(["session.created", "session.started", "model.started", "model.completed"]);
    expect(reduceAgentEvents(facts)).toMatchObject({ status: "RUNNING", lastSequence: 3, activeOperation: null });
    expect(await ledger.getSnapshot(bundle.session.sessionId)).toMatchObject({
      usage: { steps: 1, inputTokens: 80, outputTokens: 20, costUsd: 0.001 },
      reserved: { steps: 0, inputTokens: 0, outputTokens: 0 },
    });
  });

  it("rolls back the reservation when the durable started fact cannot commit", async () => {
    const storage = createStorage();
    const bundle = createBundle();
    await sessionRepository(storage).create(bundle);
    const events = new SqliteEventStore(storage, { faultInjector: { hit: () => { throw new Error("disk interrupted"); } } });
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId: bundle.session.sessionId, policy, pricingVersion: "pricing:test" });
    const approvals = new SqliteApprovalRepository(storage);
    const binding = approvalBinding(bundle);
    const operationHash = createOperationHash(binding);
    const approvalId = randomUUID();
    await issueApproved(approvals, binding, approvalId);
    const journal = new SqliteExecutionJournal(storage, events, ledger, approvals);

    await expect(journal.begin({
      identity: {
        sessionId: bundle.session.sessionId,
        taskId: bundle.rootTask.taskId,
        traceId: bundle.createdEvent.traceId,
        workspacePath: bundle.session.workspace.root.normalizedPath,
        codeVersion: "git:test",
        diffHash: null,
        configVersion: bundle.session.configVersion,
      },
      kind: "tool",
      name: binding.toolName,
      operationHash,
      estimate: budgetDeltaSchema.parse({ toolCalls: 1 }),
      authorization: { risk: "single_confirmation", authorizationId: null, approvalId },
      approvalToConsume: { approvalId, operationHash },
    })).rejects.toThrow("disk interrupted");
    await expect(approvals.get(approvalId)).resolves.toMatchObject({ state: "approved" });
    await expect(ledger.listEntries(bundle.session.sessionId)).resolves.toEqual([]);
    await expect(events.list(bundle.session.sessionId)).resolves.toHaveLength(1);
  });

  it("consumes approval, reserves budget, and records authorization in one durable start", async () => {
    const storage = createStorage();
    const bundle = createBundle();
    await sessionRepository(storage).create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId: bundle.session.sessionId, policy, pricingVersion: "pricing:test" });
    const approvals = new SqliteApprovalRepository(storage);
    const binding = approvalBinding(bundle);
    const operationHash = createOperationHash(binding);
    const approvalId = randomUUID();
    await issueApproved(approvals, binding, approvalId);
    const journal = new SqliteExecutionJournal(storage, events, ledger, approvals);

    await journal.begin({
      identity: {
        sessionId: bundle.session.sessionId,
        taskId: bundle.rootTask.taskId,
        traceId: bundle.createdEvent.traceId,
        workspacePath: bundle.session.workspace.root.normalizedPath,
        codeVersion: binding.codeVersion,
        diffHash: binding.diffHash,
        configVersion: binding.configVersion,
      },
      kind: "tool",
      name: binding.toolName,
      operationHash,
      estimate: budgetDeltaSchema.parse({ toolCalls: 1 }),
      authorization: { risk: "single_confirmation", authorizationId: null, approvalId },
      approvalToConsume: { approvalId, operationHash },
    });

    await expect(approvals.get(approvalId)).resolves.toMatchObject({ state: "consumed" });
    await expect(ledger.listEntries(bundle.session.sessionId)).resolves.toHaveLength(1);
    const facts = await events.list(bundle.session.sessionId);
    expect(facts.at(-1)).toMatchObject({
      type: "tool.started",
      context: {
        authorization: { risk: "single_confirmation", authorizationId: null, approvalId },
        operation: { operationHash },
      },
    });
  });
});

function createStorage(): SqliteStorageDatabase {
  const storage = new SqliteStorageDatabase(":memory:", { clock });
  open.push(storage);
  return storage;
}

function sessionRepository(storage: SqliteStorageDatabase): SqliteSessionRepository {
  return new SqliteSessionRepository(storage, {
    deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
  });
}

function createBundle(): CreateSessionBundle {
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const goal = "Inspect the repository";
  const normalizedPath = path.resolve("C:/workspace", workspaceId);
  const createdEvent = createAgentEvent({
    sessionId,
    taskId,
    sequence: 0,
    type: "session.created",
    context: createEventContext({ workspacePath: normalizedPath, configVersion: "config:test" }),
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
      configVersion: "config:test",
      toolCatalogHash: `sha256:${"a".repeat(64)}`,
    },
    rootTask: { schemaVersion: STORAGE_RECORD_SCHEMA_VERSION, taskId, actorId: "agent:primary", title: goal, createdAt: NOW },
    createdEvent,
  };
}

function approvalBinding(bundle: CreateSessionBundle): OperationBinding {
  return {
    bindingVersion: OPERATION_BINDING_VERSION,
    sessionId: bundle.session.sessionId,
    taskId: bundle.rootTask.taskId,
    authorizationVersion: "authorization:test-v1",
    toolName: "publish_changes",
    toolVersion: "tool:publish_changes@test",
    inputSchemaHash: `sha256:${"1".repeat(64)}`,
    normalizationVersion: "normalization:test-v1",
    effectiveInputHash: `sha256:${"2".repeat(64)}`,
    workspaceId: bundle.session.workspace.workspaceId,
    codeVersion: "git:test",
    diffHash: `sha256:${"d".repeat(64)}`,
    configVersion: bundle.session.configVersion,
  };
}

async function issueApproved(
  approvals: SqliteApprovalRepository,
  binding: OperationBinding,
  approvalId: string,
): Promise<void> {
  const expiresAt = "2999-01-01T00:00:00.000Z" as const;
  await approvals.issue({
    approvalId,
    binding,
    expiresAt,
    summary: {
      schemaVersion: 1,
      toolName: binding.toolName,
      toolVersion: binding.toolVersion,
      resources: [{ kind: "remote", value: "origin" }],
      codeVersion: binding.codeVersion,
      diffHash: binding.diffHash,
      expiresAt,
    },
  });
  await approvals.resolve({ approvalId, decision: "approved", reason: "Approved for test." });
}
