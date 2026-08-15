import { randomUUID } from "node:crypto";

import { renderToString } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext, type AgentEvent } from "../src/events/agent-event.js";
import { budgetSnapshotSchema } from "../src/policy/budget-contracts.js";
import {
  buildSessionTaskTreeLines,
  consumeSessionEvents,
  sanitizeTerminalText,
  SessionTaskTree,
  type SessionEventSource,
} from "../src/cli/ui/session-task-tree.js";
import {
  SessionTaskTreeProjectionError,
  SessionTaskTreeProjector,
} from "../src/cli/ui/session-task-tree-projector.js";

const NOW = "2026-08-15T00:00:00.000Z" as const;

describe("C13 live Session task tree", () => {
  it("projects a complete model/tool trace into a deterministic task tree", () => {
    const projector = new SessionTaskTreeProjector();
    const events = completedTrace("Inspect the repository");
    let model = projector.apply(events[0] as AgentEvent);
    for (const event of events.slice(1)) model = projector.apply(event);

    expect(model).toMatchObject({
      schemaVersion: 1,
      status: "COMPLETION_VERIFIED",
      lastSequence: 10,
      traceComplete: true,
      planRevision: 1,
      plan: ["Inspect files", "Explain findings"],
      verificationPassed: true,
      firstError: null,
      budget: {
        limitStatus: "within",
        usage: { steps: 1, toolCalls: 1, costStatus: "known" },
        reserved: { steps: 0, toolCalls: 0 },
      },
      operations: [
        { kind: "model", name: "deepseek-v4-flash", status: "completed", durationMs: 12 },
        { kind: "tool", name: "list_files", status: "completed", durationMs: 4 },
      ],
    });

    expect(buildSessionTaskTreeLines(model, 100).map((line) => line.text)).toEqual([
      `CodeFlow Session ${model.sessionId.slice(0, 8)}`,
      "✓ COMPLETION_VERIFIED · seq 10 · trace 完整",
      "目标 Inspect the repository",
      `工作区 ${model.workspacePath}`,
      "计划 r1",
      "  1. Inspect files",
      "  2. Explain findings",
      "执行",
      "  ├─ ✓ model deepseek-v4-flash · 12ms",
      "  └─ ✓ tool list_files · 4ms",
      "验证 通过",
      "预算 within · steps 1+0/5 · tools 1+0/5 · 费用 $0.000100",
    ]);
    const inkSnapshot = stripAnsi(renderToString(React.createElement(SessionTaskTree, { model, width: 100 }), { columns: 104 }));
    expect(inkSnapshot).toContain("╭");
    expect(inkSnapshot).toContain("✓ COMPLETION_VERIFIED");
    expect(inkSnapshot).toContain("├─ ✓ model deepseek-v4-flash");
    expect(inkSnapshot).toContain("└─ ✓ tool list_files");
  });

  it("renders duplicate deliveries idempotently and rejects conflicting facts", () => {
    const projector = new SessionTaskTreeProjector();
    const created = completedTrace("Inspect")[0] as AgentEvent;

    const first = projector.apply(created);
    expect(projector.apply(structuredClone(created))).toEqual(first);

    const conflict = { ...created, payload: { ...created.payload, goal: "Different" } };
    expect(() => projector.apply(conflict)).toThrowError(
      expect.objectContaining<Partial<SessionTaskTreeProjectionError>>({
        details: expect.objectContaining({ category: "event_id_conflict" }),
      }),
    );
  });

  it("consumes the C12-shaped event stream incrementally", async () => {
    const events = completedTrace("Stream events");
    let receivedOptions: { afterSequence: number; signal: AbortSignal } | null = null;
    const source: SessionEventSource = {
      streamEvents(options) {
        receivedOptions = options;
        return (async function* stream(): AsyncGenerator<AgentEvent> {
          for (const event of events) yield event;
        })();
      },
    };
    const updates: number[] = [];
    const controller = new AbortController();

    await consumeSessionEvents(
      source,
      new SessionTaskTreeProjector(),
      (model) => updates.push(model.lastSequence),
      controller.signal,
    );

    expect(receivedOptions).toMatchObject({ afterSequence: -1, signal: controller.signal });
    expect(updates).toEqual(events.map((event) => event.sequence));
  });

  it("keeps an unknown operation visible until reconciliation and preserves the first error", () => {
    const projector = new SessionTaskTreeProjector();
    const [created, started] = completedTrace("Publish safely");
    if (!created || !started) throw new Error("Trace fixture is incomplete.");
    const spanId = randomUUID();
    const identity = {
      sessionId: created.sessionId,
      taskId: created.taskId,
      traceId: created.traceId,
      occurredAt: NOW,
    } as const;
    projector.apply(created);
    projector.apply(started);
    const unknown = projector.apply(createAgentEvent({
      ...identity,
      spanId,
      sequence: 2,
      type: "operation.unknown",
      context: createEventContext({
        workspacePath: "C:/workspace",
        operation: { kind: "tool", name: "publish", status: "unknown", durationMs: 20, operationHash: "publish-hash" },
        error: {
          category: "side_effect_unknown",
          message: "Connection dropped after the request was accepted.",
          retryable: false,
          sideEffectStatus: "unknown",
          recovery: "Query the provider before retrying.",
        },
        sideEffectStatus: "unknown",
      }),
      payload: { operationHash: "publish-hash", externalId: "remote-1", recovery: "Query provider status." },
    }));

    expect(unknown).toMatchObject({
      status: "UNKNOWN",
      firstError: { sequence: 2, category: "side_effect_unknown" },
      operations: [{ name: "publish", status: "unknown" }],
    });
    expect(buildSessionTaskTreeLines(unknown, 100).map((line) => line.text).join("\n")).toContain("? tool publish");

    const reconciled = projector.apply(createAgentEvent({
      ...identity,
      spanId: randomUUID(),
      sequence: 3,
      type: "operation.reconciled",
      context: createEventContext({
        workspacePath: "C:/workspace",
        operation: { kind: "tool", name: "publish", status: "completed", durationMs: 2, operationHash: "publish-hash" },
      }),
      payload: { operationHash: "publish-hash", externalId: "remote-1", outcome: "not_applied" },
    }));

    expect(reconciled).toMatchObject({
      status: "RUNNING",
      firstError: { sequence: 2, category: "side_effect_unknown" },
      operations: [{ name: "publish", status: "reconciled", durationMs: 2 }],
    });
  });

  it("escapes terminal controls and bounds narrow output", () => {
    const projector = new SessionTaskTreeProjector();
    const model = projector.apply(completedTrace("unsafe\u001b[31m\ntext")[0] as AgentEvent);
    const lines = buildSessionTaskTreeLines(model, 28);

    expect(sanitizeTerminalText("a\u001b\nb")).toBe("a\\u001b\\u000ab");
    expect(lines.some((line) => line.text.includes("\\u001b"))).toBe(true);
    expect(lines.every((line) => terminalWidthForTest(line.text) <= 24)).toBe(true);
    expect(lines.map((line) => line.text).join("\n")).not.toContain("\u001b");
  });
});

function completedTrace(goal: string): AgentEvent[] {
  const sessionId = randomUUID();
  const taskId = randomUUID();
  const traceId = randomUUID();
  const modelSpan = randomUUID();
  const toolSpan = randomUUID();
  const identity = { sessionId, taskId, traceId, occurredAt: NOW } as const;
  const budget = budgetSnapshotSchema.parse({
    schemaVersion: 1,
    sessionId,
    usage: {
      steps: 1,
      toolCalls: 1,
      inputTokens: 20,
      outputTokens: 5,
      retries: 0,
      noProgressCycles: 0,
      activeDurationMs: 16,
      waitingDurationMs: 0,
      costUsd: 0.0001,
      costStatus: "known",
    },
    reserved: {
      steps: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      retries: 0,
      noProgressCycles: 0,
      activeDurationMs: 0,
      waitingDurationMs: 0,
      costUsd: 0,
      costStatus: "known",
    },
    limits: {
      maxSteps: 5,
      maxToolCalls: 5,
      maxDurationMs: 60_000,
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      maxCostUsd: 1,
      maxRetriesPerOperation: 1,
      maxNoProgressCycles: 2,
    },
    pricingVersion: "pricing:test",
    countWaitingTime: false,
    softLimitRatio: 0.8,
    limitStatus: "within",
    limitDimensions: [],
    updatedAt: NOW,
    lastLedgerSequence: 4,
  });
  const context = (operation: Parameters<typeof createEventContext>[0]["operation"] = null) => createEventContext({
    workspacePath: "C:/workspace",
    codeVersion: "git:test",
    diffHash: `sha256:${"d".repeat(64)}`,
    configVersion: "config:test",
    operation,
    budgetSnapshot: budget,
  });

  return [
    createAgentEvent({ ...identity, sequence: 0, type: "session.created", context: context(), payload: { goal } }),
    createAgentEvent({ ...identity, sequence: 1, type: "session.started", context: context() }),
    createAgentEvent({ ...identity, sequence: 2, type: "plan.updated", context: context(), payload: { revision: 1, reason: "Start", steps: ["Inspect files", "Explain findings"] } }),
    createAgentEvent({ ...identity, sequence: 3, spanId: modelSpan, type: "model.started", context: context({ kind: "model", name: "deepseek-v4-flash", status: "running", durationMs: null, operationHash: "model-hash" }) }),
    createAgentEvent({ ...identity, sequence: 4, spanId: modelSpan, type: "model.completed", context: context({ kind: "model", name: "deepseek-v4-flash", status: "completed", durationMs: 12, operationHash: "model-hash" }) }),
    createAgentEvent({ ...identity, sequence: 5, spanId: toolSpan, parentSpanId: modelSpan, type: "tool.started", context: context({ kind: "tool", name: "list_files", status: "running", durationMs: null, operationHash: "tool-hash" }) }),
    createAgentEvent({ ...identity, sequence: 6, spanId: toolSpan, parentSpanId: modelSpan, type: "tool.completed", context: context({ kind: "tool", name: "list_files", status: "completed", durationMs: 4, operationHash: "tool-hash" }) }),
    createAgentEvent({ ...identity, sequence: 7, type: "verification.started", context: context() }),
    createAgentEvent({ ...identity, sequence: 8, type: "verification.completed", context: context(), payload: { passed: true } }),
    createAgentEvent({ ...identity, sequence: 9, type: "completion.claimed", context: context() }),
    createAgentEvent({ ...identity, sequence: 10, type: "completion.verified", context: context() }),
  ];
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function terminalWidthForTest(value: string): number {
  return [...value].reduce((width, character) => {
    if (/\p{Mark}/u.test(character)) return width;
    const codePoint = character.codePointAt(0) ?? 0;
    const wide = /\p{Script=Han}/u.test(character) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff);
    return width + (wide ? 2 : 1);
  }, 0);
}
