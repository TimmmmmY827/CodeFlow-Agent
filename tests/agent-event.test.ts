import { randomUUID } from "node:crypto";

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
      workspacePath: "C:/workspace",
      codeVersion: "git:abc123",
      operation: { name: "read_file", durationMs: 18 },
      sideEffectStatus: "none",
    });
  });
});
