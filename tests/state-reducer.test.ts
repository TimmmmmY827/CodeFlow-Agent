import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { reduceAgentEvents } from "../src/events/state-reducer.js";

describe("reduceAgentEvents", () => {
  it("derives the visible task state from append-only facts", () => {
    const sessionId = randomUUID();
    const taskId = randomUUID();
    const traceId = randomUUID();
    const common = {
      sessionId,
      taskId,
      traceId,
      context: createEventContext({
        workspacePath: "C:/workspace",
        codeVersion: "git:abc123",
        configVersion: "config:v1",
      }),
    };

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
        payload: {
          revision: 1,
          reason: "Initial execution plan",
          steps: ["Reproduce", "Patch", "Verify"],
        },
      }),
      createAgentEvent({ ...common, sequence: 3, type: "verification.started" }),
      createAgentEvent({
        ...common,
        sequence: 4,
        type: "verification.completed",
        payload: { passed: true },
      }),
      createAgentEvent({ ...common, sequence: 5, type: "completion.claimed" }),
      createAgentEvent({ ...common, sequence: 6, type: "completion.verified" }),
    ]);

    expect(view).toMatchObject({
      sessionId,
      status: "COMPLETION_VERIFIED",
      goal: "Fix the failing parser test",
      plan: ["Reproduce", "Patch", "Verify"],
      verificationPassed: true,
      lastSequence: 6,
    });
  });

  it("represents user waits and completion claims as distinct states", () => {
    const common = {
      sessionId: randomUUID(),
      taskId: randomUUID(),
      traceId: randomUUID(),
      context: createEventContext({ workspacePath: "C:/workspace" }),
    };

    const waiting = reduceAgentEvents([
      createAgentEvent({ ...common, sequence: 0, type: "session.created" }),
      createAgentEvent({ ...common, sequence: 1, type: "session.started" }),
      createAgentEvent({ ...common, sequence: 2, type: "user.input.requested" }),
    ]);
    const claimed = reduceAgentEvents([
      createAgentEvent({ ...common, sequence: 0, type: "session.created" }),
      createAgentEvent({ ...common, sequence: 1, type: "session.started" }),
      createAgentEvent({ ...common, sequence: 2, type: "user.input.requested" }),
      createAgentEvent({ ...common, sequence: 3, type: "user.input.received" }),
      createAgentEvent({ ...common, sequence: 4, type: "completion.claimed" }),
    ]);

    expect(waiting?.status).toBe("WAITING_USER");
    expect(claimed?.status).toBe("COMPLETION_CLAIMED");
  });
});
