import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentEventLoop } from "../src/agent/agent-event-loop.js";
import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { reduceAgentEvents } from "../src/events/state-reducer.js";
import { DeepSeekChatAdapter } from "../src/model/deepseek-chat-adapter.js";
import { DEEPSEEK_PRICING_VERSION } from "../src/model/deepseek-pricing.js";
import type { BudgetPolicy } from "../src/policy/budget-contracts.js";
import { PermissionEngine } from "../src/policy/permission-engine.js";
import { STORAGE_RECORD_SCHEMA_VERSION, type CreateSessionBundle } from "../src/storage/contracts.js";
import { SqliteBudgetLedger } from "../src/storage/sqlite/sqlite-budget-ledger.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteEventStore } from "../src/storage/sqlite/sqlite-event-store.js";
import { SqliteExecutionJournal } from "../src/storage/sqlite/sqlite-execution-journal.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";
import { registerWorkspaceReadTools } from "../src/tools/builtin/workspace-read-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime } from "../src/tools/tool-runtime.js";

const live = process.env.RUN_DEEPSEEK_LIVE === "1";

describe.skipIf(!live)("DeepSeek live read-only acceptance", () => {
  it("uses a real tool call and reaches a replayable terminal state", async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required when RUN_DEEPSEEK_LIVE=1.");
    const workspace = path.resolve(process.cwd());
    const codeVersion = "git:live-readonly";
    const diffHash = `sha256:${createHash("sha256").update(workspace).digest("hex")}`;
    using storage = new SqliteStorageDatabase(":memory:");
    const bundle = createBundle(workspace);
    await new SqliteSessionRepository(storage, {
      deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
    }).create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId: bundle.session.sessionId, policy: livePolicy, pricingVersion: DEEPSEEK_PRICING_VERSION });
    const journal = new SqliteExecutionJournal(storage, events, ledger);
    const registry = new ToolRegistry();
    registerWorkspaceReadTools(registry);
    const loop = new AgentEventLoop(events, {
      modelAdapter: new DeepSeekChatAdapter({ apiKey, model: "deepseek-v4-flash", timeoutMs: 60_000 }),
      toolRegistry: registry,
      toolRuntime: new ToolRuntime(registry, new PermissionEngine(), { journal }),
      journal,
      completionSnapshotProvider: { capture: async () => ({ codeVersion, diffHash }) },
      maxSteps: 3,
      maxOutputTokens: 128,
    });

    const result = await loop.runReadonlySession({
      sessionId: bundle.session.sessionId,
      taskId: bundle.rootTask.taskId,
      traceId: bundle.createdEvent.traceId,
      workspacePath: workspace,
      codeVersion,
      diffHash,
      configVersion: bundle.session.configVersion,
      goal: "Use list_files to identify one top-level repository entry, then answer with only that entry name.",
      signal: AbortSignal.timeout(90_000),
    });

    const facts = await events.list(bundle.session.sessionId);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" });
    expect(result.toolCalls).toBeGreaterThan(0);
    expect(reduceAgentEvents(facts)).toMatchObject({ status: "COMPLETION_VERIFIED", traceComplete: true });
    expect(await ledger.listOpenReservations(bundle.session.sessionId)).toEqual([]);
    const snapshot = await ledger.getSnapshot(bundle.session.sessionId);
    const completedModels = facts.filter((event) => event.type === "model.completed");
    console.info("DEEPSEEK_LIVE_EVIDENCE", JSON.stringify({
      model: "deepseek-v4-flash",
      responseIds: completedModels.map((event) => event.payload.responseId),
      modelAttempts: result.modelAttempts,
      toolCalls: result.toolCalls,
      eventCount: facts.length,
      usage: snapshot?.usage ?? null,
    }));
  }, 120_000);
});

const livePolicy: BudgetPolicy = {
  limits: { maxSteps: 3, maxToolCalls: 4, maxDurationMs: 90_000, maxInputTokens: 30_000, maxOutputTokens: 1_000, maxCostUsd: 0.05, maxRetriesPerOperation: 1, maxNoProgressCycles: 2 },
  softLimitRatio: 0.8,
  countWaitingTime: false,
};

function createBundle(workspace: string): CreateSessionBundle {
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const createdAt = new Date().toISOString();
  const goal = "Live read-only acceptance";
  const createdEvent = createAgentEvent({ sessionId, taskId, sequence: 0, type: "session.created", context: createEventContext({ workspacePath: workspace, configVersion: "config:live" }), payload: { goal }, occurredAt: createdAt });
  return {
    session: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId,
      workspace: { schemaVersion: STORAGE_RECORD_SCHEMA_VERSION, workspaceId, root: { normalizedPath: workspace, displayPath: workspace }, fingerprint: `fingerprint:${workspaceId}`, createdAt },
      goal,
      createdAt,
      expiresAt: null,
      configVersion: "config:live",
      toolCatalogHash: `sha256:${"a".repeat(64)}`,
    },
    rootTask: { schemaVersion: STORAGE_RECORD_SCHEMA_VERSION, taskId, actorId: "agent:primary", title: goal, createdAt },
    createdEvent,
  };
}
