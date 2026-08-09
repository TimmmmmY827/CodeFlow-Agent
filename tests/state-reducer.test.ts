import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAgentEvent } from "../src/events/agent-event.js";
import { reduceAgentEvents } from "../src/events/state-reducer.js";

describe("reduceAgentEvents", () => {
  it("derives the visible task state from append-only facts", () => {
    const sessionId = randomUUID();
    const taskId = randomUUID();
    const traceId = randomUUID();
    const common = { sessionId, taskId, traceId };

    const view = reduceAgentEvents([
      createAgentEvent({
        ...common,
        sequence: 0,
        type: "session.created",
        payload: { goal: "Fix the failing parser test" },
      }),
      createAgentEvent({ ...common, sequence: 1, type: "session.started" }),
      createAgentEvent({
        ...common,
        sequence: 2,
        type: "plan.updated",
        payload: { steps: ["Reproduce", "Patch", "Verify"] },
      }),
      createAgentEvent({ ...common, sequence: 3, type: "verification.started" }),
      createAgentEvent({
        ...common,
        sequence: 4,
        type: "verification.completed",
        payload: { passed: true },
      }),
      createAgentEvent({ ...common, sequence: 5, type: "session.completed" }),
    ]);

    expect(view).toMatchObject({
      sessionId,
      status: "COMPLETION_VERIFIED",
      goal: "Fix the failing parser test",
      plan: ["Reproduce", "Patch", "Verify"],
      verificationPassed: true,
      lastSequence: 5,
    });
  });
});
