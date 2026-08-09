import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAgentEvent } from "../src/events/agent-event.js";
import { exportSanitizedTrace } from "../src/trace/trace-exporter.js";

describe("exportSanitizedTrace", () => {
  it("removes credential and reasoning fields", () => {
    const output = exportSanitizedTrace([
      createAgentEvent({
        sessionId: randomUUID(),
        taskId: randomUUID(),
        sequence: 0,
        type: "model.completed",
        payload: {
          summary: "Read two files",
          apiKey: "do-not-export",
          nested: { reasoning: "do-not-export-either" },
        },
      }),
    ]);

    expect(output).toContain("Read two files");
    expect(output).not.toContain("do-not-export");
    expect(output).toContain("[REDACTED]");
  });
});
