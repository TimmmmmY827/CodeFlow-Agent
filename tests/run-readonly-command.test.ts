import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RunningReadonlySession } from "../src/app/readonly-session-runner.js";
import { ReplayTailSessionEventSource } from "../src/app/session-event-source.js";
import { executeReadonlyRun } from "../src/cli/run-readonly-command.js";
import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { InMemoryEventStore } from "../src/events/event-store.js";

describe("codeflow run presentation", () => {
  it("renders a completed Session without ANSI in non-interactive mode", async () => {
    const fixture = await completedSession("answer\u001b[31m");
    const output: string[] = [];
    let closed = 0;

    const outcome = await executeReadonlyRun(
      {
        goal: "Inspect",
        workspace: "C:/workspace",
        signal: new AbortController().signal,
        dataDirectory: "C:/data",
        apiKey: "test-key-never-printed",
        interactive: false,
        terminalWidth: 80,
      },
      {
        startSession: async () => ({ ...fixture.running, close: () => { closed += 1; } }),
        writeLine: (line) => output.push(line),
      },
    );

    expect(outcome).toMatchObject({ exitCode: 0, result: { status: "completed" }, view: { status: "COMPLETION_VERIFIED" } });
    expect(closed).toBe(1);
    expect(output.join("\n")).toContain("✓ COMPLETION_VERIFIED");
    expect(output.join("\n")).toContain("结果 answer\\u001b[31m");
    expect(output.join("\n")).not.toContain("\u001b");
    expect(output.join("\n")).not.toContain("test-key-never-printed");
  });

  it("continues the presentation stream long enough to show cancellation facts", async () => {
    const fixture = await cancelledSession();
    const output: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const outcome = await executeReadonlyRun(
      {
        goal: "Inspect",
        workspace: "C:/workspace",
        signal: controller.signal,
        dataDirectory: "C:/data",
        apiKey: "test-key-never-printed",
        interactive: false,
      },
      { startSession: async () => fixture.running, writeLine: (line) => output.push(line) },
    );

    expect(outcome).toMatchObject({ exitCode: 4, view: { status: "CANCELLED", lastSequence: 3 } });
    expect(output.join("\n")).toContain("CANCELLED");
  });
});

async function completedSession(outputText: string): Promise<{ running: RunningReadonlySession }> {
  const sessionId = randomUUID();
  const taskId = randomUUID();
  const traceId = randomUUID();
  const identity = { sessionId, taskId, traceId, occurredAt: "2026-08-15T00:00:00.000Z" as const };
  const context = createEventContext({ workspacePath: "C:/workspace" });
  const store = new InMemoryEventStore();
  await store.append(createAgentEvent({ ...identity, sequence: 0, type: "session.created", context, payload: { goal: "Inspect" } }));
  await store.append(createAgentEvent({ ...identity, sequence: 1, type: "session.started", context }));
  await store.append(createAgentEvent({ ...identity, sequence: 2, type: "completion.claimed", context }));
  await store.append(createAgentEvent({ ...identity, sequence: 3, type: "completion.verified", context }));
  const source = new ReplayTailSessionEventSource(sessionId, store);
  return {
    running: {
      sessionId,
      completion: Promise.resolve({ status: "completed", outputText, modelAttempts: 1, toolCalls: 1, error: null }),
      streamEvents: (options) => source.streamEvents(options),
      close: () => undefined,
    },
  };
}

async function cancelledSession(): Promise<{ running: RunningReadonlySession }> {
  const sessionId = randomUUID();
  const taskId = randomUUID();
  const traceId = randomUUID();
  const identity = { sessionId, taskId, traceId, occurredAt: "2026-08-15T00:00:00.000Z" as const };
  const context = createEventContext({ workspacePath: "C:/workspace" });
  const store = new InMemoryEventStore();
  await store.append(createAgentEvent({ ...identity, sequence: 0, type: "session.created", context, payload: { goal: "Inspect" } }));
  await store.append(createAgentEvent({ ...identity, sequence: 1, type: "session.started", context }));
  await store.append(createAgentEvent({ ...identity, sequence: 2, type: "session.cancelling", context }));
  await store.append(createAgentEvent({ ...identity, sequence: 3, type: "session.cancelled", context }));
  const source = new ReplayTailSessionEventSource(sessionId, store);
  return {
    running: {
      sessionId,
      completion: Promise.resolve({
        status: "cancelled",
        outputText: null,
        modelAttempts: 0,
        toolCalls: 0,
        error: { category: "cancelled", message: "Cancelled.", retryable: false, sideEffectStatus: "none", recovery: null },
      }),
      streamEvents: (options) => source.streamEvents(options),
      close: () => undefined,
    },
  };
}
