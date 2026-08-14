import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { exportSanitizedTrace } from "../src/trace/trace-exporter.js";

describe("exportSanitizedTrace", () => {
  it("removes credential and reasoning fields", () => {
    const output = exportSanitizedTrace([
      createAgentEvent({
        sessionId: randomUUID(),
        taskId: randomUUID(),
        sequence: 0,
        type: "model.completed",
        context: createEventContext({
          workspacePath: "C:/workspace",
          operation: {
            kind: "model",
            name: "deepseek-v4-flash",
            status: "completed",
            durationMs: 120,
          },
          usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 5, costUsd: 0.001 },
          authorization: {
            risk: "automatic",
            authorizationId: "auth-secret-reference",
            approvalId: null,
          },
        }),
        payload: {
          summary: "Read two files",
          apiKey: "do-not-export",
          approvalToken: "do-not-export-token",
          authorization: { scheme: "Bearer", value: "do-not-export-authorization" },
          nested: { reasoning: "do-not-export-either" },
        },
      }),
    ]);

    expect(output).toContain("Read two files");
    expect(output).toContain('"inputTokens": 20');
    expect(output).not.toContain("do-not-export");
    expect(output).toContain("auth-secret-reference");
    expect(output).toContain("[REDACTED]");
  });
});
