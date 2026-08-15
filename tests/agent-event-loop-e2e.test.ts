import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentEventLoop } from "../src/agent/agent-event-loop.js";
import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import type { ExecutionJournal } from "../src/events/execution-journal.js";
import { reduceAgentEvents } from "../src/events/state-reducer.js";
import { DEEPSEEK_PRICING_VERSION } from "../src/model/deepseek-pricing.js";
import { MODEL_ADAPTER_PROTOCOL_VERSION, type ModelAdapter, type ModelRequest, type ModelResponse } from "../src/model/model-adapter.js";
import type { BudgetPolicy } from "../src/policy/budget-contracts.js";
import { PermissionEngine } from "../src/policy/permission-engine.js";
import type { Clock } from "../src/shared/contracts.js";
import { STORAGE_RECORD_SCHEMA_VERSION, type CreateSessionBundle } from "../src/storage/contracts.js";
import { SqliteBudgetLedger } from "../src/storage/sqlite/sqlite-budget-ledger.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteEventStore } from "../src/storage/sqlite/sqlite-event-store.js";
import { SqliteExecutionJournal } from "../src/storage/sqlite/sqlite-execution-journal.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";
import { registerWorkspaceReadTools } from "../src/tools/builtin/workspace-read-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime } from "../src/tools/tool-runtime.js";

const NOW = "2026-08-15T00:00:00.000Z" as const;
const CODE_VERSION = "git:test";
const DIFF_HASH = `sha256:${"d".repeat(64)}`;
const clock: Clock = { utcNow: () => NOW, monotonicNowMs: () => 0 };
const policy: BudgetPolicy = {
  limits: { maxSteps: 5, maxToolCalls: 5, maxDurationMs: 60_000, maxInputTokens: 50_000, maxOutputTokens: 10_000, maxCostUsd: 1, maxRetriesPerOperation: 1, maxNoProgressCycles: 2 },
  softLimitRatio: 0.8,
  countWaitingTime: false,
};
const workspaces: string[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true });
});

describe("AgentEventLoop read-only vertical slice", () => {
  it("runs model -> tool -> model and produces a budgeted replayable completion", async () => {
    const workspace = await createWorkspace();
    using storage = new SqliteStorageDatabase(":memory:", { clock });
    const bundle = createBundle(workspace);
    await sessionRepository(storage).create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId: bundle.session.sessionId, policy, pricingVersion: DEEPSEEK_PRICING_VERSION });
    const journal = new SqliteExecutionJournal(storage, events, ledger);
    const registry = new ToolRegistry();
    registerWorkspaceReadTools(registry);
    const runtime = new ToolRuntime(registry, new PermissionEngine(), { journal });
    const model = new ScriptedModelAdapter();
    const loop = new AgentEventLoop(events, {
      modelAdapter: model,
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      completionSnapshotProvider: { capture: async () => ({ codeVersion: CODE_VERSION, diffHash: DIFF_HASH }) },
      maxSteps: 4,
      maxOutputTokens: 128,
    });

    const result = await loop.runReadonlySession({
      sessionId: bundle.session.sessionId,
      taskId: bundle.rootTask.taskId,
      traceId: bundle.createdEvent.traceId,
      workspacePath: workspace,
      codeVersion: CODE_VERSION,
      diffHash: DIFF_HASH,
      configVersion: bundle.session.configVersion,
      goal: bundle.session.goal,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "completed",
      outputText: "The repository contains README.md.",
      modelAttempts: 2,
      toolCalls: 1,
      error: null,
    });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]).toMatchObject({ toolChoice: "required", maxOutputTokens: 128 });
    expect(model.requests[1]).toMatchObject({ toolChoice: "auto" });
    const facts = await events.list(bundle.session.sessionId);
    expect(facts.map((event) => event.type)).toEqual([
      "session.created",
      "session.started",
      "model.started",
      "model.completed",
      "tool.started",
      "tool.completed",
      "model.started",
      "model.completed",
      "verification.started",
      "verification.completed",
      "completion.claimed",
      "completion.verified",
    ]);
    expect(reduceAgentEvents(facts)).toMatchObject({ status: "COMPLETION_VERIFIED", lastSequence: 11, traceComplete: true });
    expect(await ledger.getSnapshot(bundle.session.sessionId)).toMatchObject({
      usage: { steps: 2, toolCalls: 1, inputTokens: 42, outputTokens: 13 },
      reserved: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
      limitStatus: "within",
    });
  });

  it("cancels before the first paid model attempt and writes terminal facts", async () => {
    const workspace = await createWorkspace();
    using storage = new SqliteStorageDatabase(":memory:", { clock });
    const bundle = createBundle(workspace);
    await sessionRepository(storage).create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId: bundle.session.sessionId, policy, pricingVersion: DEEPSEEK_PRICING_VERSION });
    const journal = new SqliteExecutionJournal(storage, events, ledger);
    const registry = new ToolRegistry();
    registerWorkspaceReadTools(registry);
    const model = new ScriptedModelAdapter();
    const controller = new AbortController();
    controller.abort();
    const loop = new AgentEventLoop(events, {
      modelAdapter: model,
      toolRegistry: registry,
      toolRuntime: new ToolRuntime(registry, new PermissionEngine(), { journal }),
      journal,
      completionSnapshotProvider: { capture: async () => ({ codeVersion: CODE_VERSION, diffHash: DIFF_HASH }) },
    });

    const result = await loop.runReadonlySession({
      sessionId: bundle.session.sessionId,
      taskId: bundle.rootTask.taskId,
      traceId: bundle.createdEvent.traceId,
      workspacePath: workspace,
      codeVersion: CODE_VERSION,
      diffHash: DIFF_HASH,
      configVersion: bundle.session.configVersion,
      goal: bundle.session.goal,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: "cancelled", modelAttempts: 0, toolCalls: 0 });
    expect(model.requests).toEqual([]);
    expect((await events.list(bundle.session.sessionId)).map((event) => event.type)).toEqual([
      "session.created", "session.started", "session.cancelling", "session.cancelled",
    ]);
    expect(await ledger.listEntries(bundle.session.sessionId)).toEqual([]);
  });

  it("does not call the paid model when durable budget admission fails", async () => {
    const workspace = await createWorkspace();
    using storage = new SqliteStorageDatabase(":memory:", { clock });
    const bundle = createBundle(workspace);
    await sessionRepository(storage).create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({
      sessionId: bundle.session.sessionId,
      policy: { ...policy, limits: { ...policy.limits, maxCostUsd: 0 } },
      pricingVersion: DEEPSEEK_PRICING_VERSION,
    });
    const journal = new SqliteExecutionJournal(storage, events, ledger);
    const registry = new ToolRegistry();
    registerWorkspaceReadTools(registry);
    const model = new ScriptedModelAdapter();
    const loop = new AgentEventLoop(events, {
      modelAdapter: model,
      toolRegistry: registry,
      toolRuntime: new ToolRuntime(registry, new PermissionEngine(), { journal }),
      journal,
      completionSnapshotProvider: { capture: async () => ({ codeVersion: CODE_VERSION, diffHash: DIFF_HASH }) },
      maxOutputTokens: 128,
    });

    const result = await loop.runReadonlySession({
      sessionId: bundle.session.sessionId,
      taskId: bundle.rootTask.taskId,
      traceId: bundle.createdEvent.traceId,
      workspacePath: workspace,
      codeVersion: CODE_VERSION,
      diffHash: DIFF_HASH,
      configVersion: bundle.session.configVersion,
      goal: bundle.session.goal,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "failed", modelAttempts: 0, toolCalls: 0 });
    expect(model.requests).toEqual([]);
    expect((await events.list(bundle.session.sessionId)).map((event) => event.type)).toEqual([
      "session.created", "session.started", "session.failed",
    ]);
    expect(await ledger.listEntries(bundle.session.sessionId)).toEqual([]);
  });

  it("returns a structured failure and records session.failed when model journal finish fails", async () => {
    const workspace = await createWorkspace();
    using storage = new SqliteStorageDatabase(":memory:", { clock });
    const bundle = createBundle(workspace);
    await sessionRepository(storage).create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId: bundle.session.sessionId, policy, pricingVersion: DEEPSEEK_PRICING_VERSION });
    const durableJournal = new SqliteExecutionJournal(storage, events, ledger);
    const finishFailingJournal: ExecutionJournal = {
      append: async (input) => await durableJournal.append(input),
      begin: async (input) => await durableJournal.begin(input),
      finish: async () => { throw new Error("injected model finish failure"); },
    };
    const registry = new ToolRegistry();
    registerWorkspaceReadTools(registry);
    const loop = new AgentEventLoop(events, {
      modelAdapter: new ScriptedModelAdapter(),
      toolRegistry: registry,
      toolRuntime: new ToolRuntime(registry, new PermissionEngine(), { journal: finishFailingJournal }),
      journal: finishFailingJournal,
      completionSnapshotProvider: { capture: async () => ({ codeVersion: CODE_VERSION, diffHash: DIFF_HASH }) },
      maxOutputTokens: 128,
    });

    const result = await loop.runReadonlySession({
      sessionId: bundle.session.sessionId,
      taskId: bundle.rootTask.taskId,
      traceId: bundle.createdEvent.traceId,
      workspacePath: workspace,
      codeVersion: CODE_VERSION,
      diffHash: DIFF_HASH,
      configVersion: bundle.session.configVersion,
      goal: bundle.session.goal,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      modelAttempts: 1,
      toolCalls: 0,
      error: { category: "model_journal_finish_failed", retryable: false },
    });
    const facts = await events.list(bundle.session.sessionId);
    expect(facts.map((event) => event.type)).toEqual([
      "session.created",
      "session.started",
      "model.started",
      "session.failed",
    ]);
    expect(reduceAgentEvents(facts)).toMatchObject({ status: "FAILED", lastErrorCategory: "model_journal_finish_failed" });
    await expect(ledger.listOpenReservations(bundle.session.sessionId)).resolves.toHaveLength(1);
  });
});

class ScriptedModelAdapter implements ModelAdapter {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-flash";
  readonly requests: ModelRequest[] = [];

  capabilities() {
    return {
      protocolVersion: MODEL_ADAPTER_PROTOCOL_VERSION,
      streaming: false as const,
      toolCalling: true as const,
      parallelToolCalls: true as const,
      reasoningContinuation: false as const,
      serverSideTools: false as const,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        responseId: "response-tool",
        model: this.model,
        outputText: "",
        toolCalls: [{ callId: "call-list", name: "list_files", argumentsJson: "{\"path\":\".\",\"maxDepth\":1}", arguments: { path: ".", maxDepth: 1 } }],
        finishReason: "tool_calls",
        usage: usage(20, 5),
      };
    }
    return {
      responseId: "response-final",
      model: this.model,
      outputText: "The repository contains README.md.",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(22, 8),
    };
  }
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cachedTokens: 0,
    totalTokens: inputTokens + outputTokens,
    costUsd: null,
    durationMs: 10,
    providerUsage: {},
  };
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "codeflow-loop-"));
  workspaces.push(workspace);
  await writeFile(path.join(workspace, "README.md"), "# Fixture\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, windowsHide: true });
  return workspace;
}

function sessionRepository(storage: SqliteStorageDatabase): SqliteSessionRepository {
  return new SqliteSessionRepository(storage, { deletedSessionIdentity: { hasDeletedSessionIdentity: () => false } });
}

function createBundle(workspace: string): CreateSessionBundle {
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const goal = "Inspect the repository";
  const createdEvent = createAgentEvent({
    sessionId,
    taskId,
    sequence: 0,
    type: "session.created",
    context: createEventContext({ workspacePath: workspace, configVersion: "config:test" }),
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
        root: { normalizedPath: workspace, displayPath: workspace },
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
