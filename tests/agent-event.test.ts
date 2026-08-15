import { randomUUID } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { agentEventSchema, createAgentEvent, createEventContext } from "../src/events/agent-event.js";

describe("AgentEvent", () => {
  it("keeps audit-critical execution fields outside the free-form payload", () => {
    const event = createAgentEvent({
      sessionId: randomUUID(),
      taskId: randomUUID(),
      sequence: 4,
      type: "tool.completed",
      context: createEventContext({
        workspacePath: "C:/workspace",
        codeVersion: "git:abc123",
        configVersion: "config:v2",
        operation: {
          kind: "tool",
          name: "read_file",
          status: "completed",
          durationMs: 18,
        },
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
        authorization: {
          risk: "automatic",
          authorizationId: "task-auth-1",
          approvalId: null,
        },
        sideEffectStatus: "none",
      }),
      payload: { resultSummary: "12 lines" },
    });

    expect(agentEventSchema.parse(event).context).toMatchObject({
      workspacePath: path.resolve("C:/workspace"),
      codeVersion: "git:abc123",
      operation: { name: "read_file", durationMs: 18 },
      sideEffectStatus: "none",
    });
  });

  it("keeps pre-C04 v1 events canonical when budgetSnapshot is absent", () => {
    const event = createAgentEvent({
      sessionId: randomUUID(),
      taskId: randomUUID(),
      sequence: 0,
      type: "session.created",
      context: createEventContext({ workspacePath: "C:/workspace" }),
    });
    const { budgetSnapshot: _removed, ...legacyContext } = event.context;
    const parsed = agentEventSchema.parse({ ...event, context: legacyContext });

    expect(Object.hasOwn(parsed.context, "budgetSnapshot")).toBe(false);
  });
});
