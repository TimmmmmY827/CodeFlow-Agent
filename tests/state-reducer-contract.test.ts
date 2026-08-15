import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import {
  StateReducer,
  checkTraceIntegrity,
  reduceAgentEvents,
} from "../src/events/state-reducer.js";
import { BUDGET_SCHEMA_VERSION, type BudgetSnapshot } from "../src/policy/budget-contracts.js";

describe("C01 event/state contracts", () => {
  it("projects plan revisions, budget, and pending approvals", () => {
    const ids = identifiers();
    const view = reduceAgentEvents([
      created(ids, 0),
      started(ids, 1),
      createAgentEvent({
        ...ids,
        sequence: 2,
        type: "plan.updated",
        context: createEventContext({ workspacePath: "." }),
        payload: { revision: 1, reason: "Initial plan", steps: ["Inspect", "Verify"] },
      }),
      createAgentEvent({
        ...ids,
        sequence: 3,
        type: "budget.updated",
        context: createEventContext({
          workspacePath: ".",
          budgetSnapshot: budgetSnapshot(ids.sessionId, 1, 3),
        }),
      }),
      createAgentEvent({
        ...ids,
        sequence: 4,
        type: "approval.requested",
        context: createEventContext({
          workspacePath: ".",
          authorization: { risk: "single_confirmation", authorizationId: null, approvalId: "approval-1" },
          operation: { kind: "tool", name: "publish", status: "pending", durationMs: null, operationHash: "hash-1" },
        }),
        payload: { approvalId: "approval-1", toolName: "publish", operationHash: "hash-1" },
      }),
      createAgentEvent({
        ...ids,
        sequence: 5,
        type: "approval.resolved",
        context: createEventContext({ workspacePath: "." }),
        payload: { approvalId: "approval-1" },
      }),
    ]);

    expect(view).toMatchObject({
      status: "RUNNING",
      plan: ["Inspect", "Verify"],
      planRevision: 1,
      planChangeReason: "Initial plan",
      budget: { usage: { toolCalls: 0 } },
      pendingApproval: null,
      traceComplete: true,
    });
  });

  it("pairs tool facts by operation hash even when spans differ", () => {
    const ids = identifiers();
    const startedSpan = randomUUID();
    const view = reduceAgentEvents([
      created(ids, 0),
      started(ids, 1),
      createAgentEvent({
        ...ids,
        sequence: 2,
        spanId: startedSpan,
        type: "tool.started",
        context: createEventContext({
          workspacePath: ".",
          operation: { kind: "tool", name: "read_file", status: "running", durationMs: null, operationHash: "hash-read" },
        }),
        payload: {},
      }),
      createAgentEvent({
        ...ids,
        sequence: 3,
        spanId: randomUUID(),
        type: "tool.completed",
        context: createEventContext({
          workspacePath: ".",
          operation: { kind: "tool", name: "read_file", status: "completed", durationMs: 5, operationHash: "hash-read" },
        }),
        payload: {},
      }),
    ]);

    expect(view).toMatchObject({ status: "RUNNING", activeOperation: null });
  });

  it("rejects unmatched operation completions and illegal lifecycle transitions", () => {
    const ids = identifiers();
    const unmatched = createAgentEvent({
      ...ids,
      sequence: 2,
      type: "tool.completed",
      context: createEventContext({
        workspacePath: ".",
        operation: { kind: "tool", name: "read_file", status: "completed", durationMs: 1, operationHash: "missing" },
      }),
      payload: {},
    });

    expect(() => reduceAgentEvents([created(ids, 0), started(ids, 1), unmatched])).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ category: "event_operation_mismatch" }) }),
    );

    const invalidCompletion = createAgentEvent({ ...ids, sequence: 2, type: "completion.verified", context: createEventContext({ workspacePath: "." }) });
    expect(() => reduceAgentEvents([created(ids, 0), started(ids, 1), invalidCompletion])).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ category: "event_invalid_transition" }) }),
    );
  });

  it("requires reconciliation details for UNKNOWN and returns to RUNNING after reconciliation", () => {
    const ids = identifiers();
    const unknownContext = createEventContext({
      workspacePath: ".",
      operation: { kind: "tool", name: "publish", status: "unknown", durationMs: 20, operationHash: "publish-hash" },
      error: {
        category: "side_effect_unknown",
        message: "Connection dropped after the remote accepted the request.",
        retryable: false,
        sideEffectStatus: "unknown",
        recovery: "Query the provider using externalId before retrying.",
      },
      sideEffectStatus: "unknown",
    });
    const view = reduceAgentEvents([
      created(ids, 0),
      started(ids, 1),
      createAgentEvent({
        ...ids,
        sequence: 2,
        type: "operation.unknown",
        context: unknownContext,
        payload: { operationHash: "publish-hash", externalId: "remote-1", recovery: "Query provider status." },
      }),
      createAgentEvent({
        ...ids,
        sequence: 3,
        type: "operation.reconciled",
        context: createEventContext({
          workspacePath: ".",
          operation: { kind: "tool", name: "publish", status: "completed", durationMs: 2, operationHash: "publish-hash" },
        }),
        payload: { operationHash: "publish-hash", externalId: "remote-1", outcome: "not_applied" },
      }),
    ]);

    expect(view).toMatchObject({ status: "RUNNING", activeOperation: null, lastErrorCategory: "side_effect_unknown" });
  });

  it("reports the first trace gap, schema failure, and cross-session event", () => {
    const ids = identifiers();
    const gap = checkTraceIntegrity([created(ids, 0), started(ids, 2)]);
    expect(gap).toMatchObject({ complete: false, firstGap: 1, firstError: { category: "trace_incomplete" } });

    const unknownSchema = checkTraceIntegrity([{ ...created(ids, 0), schemaVersion: 99 }]);
    expect(unknownSchema).toMatchObject({ complete: false, firstError: { category: "unsupported_schema_version" } });

    const otherSession = { ...started(ids, 1), sessionId: randomUUID() };
    const crossSession = checkTraceIntegrity([created(ids, 0), otherSession]);
    expect(crossSession).toMatchObject({ complete: false, firstError: { category: "cross_session_event" } });
  });

  it("keeps batch replay equal to incremental replay for ten thousand budget facts", () => {
    const ids = identifiers();
    const events = [created(ids, 0), started(ids, 1)];
    for (let sequence = 2; sequence < 10_002; sequence += 1) {
      events.push(createAgentEvent({
        ...ids,
        sequence,
        type: "budget.updated",
        context: createEventContext({
          workspacePath: ".",
          budgetSnapshot: budgetSnapshot(ids.sessionId, sequence - 1, sequence),
        }),
      }));
    }

    const incremental = new StateReducer();
    for (const event of events) incremental.apply(event);

    expect(incremental.snapshot()).toEqual(reduceAgentEvents(events));
  });
});

function identifiers() {
  return { sessionId: randomUUID(), taskId: randomUUID(), traceId: randomUUID() };
}

function created(ids: ReturnType<typeof identifiers>, sequence: number) {
  return createAgentEvent({
    ...ids,
    sequence,
    type: "session.created",
    context: createEventContext({ workspacePath: "." }),
    payload: { goal: "C01 test" },
  });
}

function started(ids: ReturnType<typeof identifiers>, sequence: number) {
  return createAgentEvent({
    ...ids,
    sequence,
    type: "session.started",
    context: createEventContext({ workspacePath: "." }),
  });
}

function budgetSnapshot(sessionId: string, steps: number, sequence: number): BudgetSnapshot {
  return {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    sessionId,
    usage: {
      steps,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      retries: 0,
      noProgressCycles: 0,
      activeDurationMs: sequence,
      waitingDurationMs: 0,
      costUsd: 0,
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
      maxSteps: 20_000,
      maxToolCalls: 20_000,
      maxDurationMs: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      maxCostUsd: 10,
      maxRetriesPerOperation: 3,
      maxNoProgressCycles: 3,
    },
    pricingVersion: "pricing:test",
    countWaitingTime: false,
    softLimitRatio: 0.8,
    updatedAt: "2026-08-15T00:00:00.000Z",
    lastLedgerSequence: sequence,
  };
}
