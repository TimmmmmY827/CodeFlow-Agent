import type {
  AgentEvent,
} from "./agent-event.js";
import { parseAgentEvent } from "./agent-event.js";
import type { JsonObject } from "../shared/json.js";
import type { StableId, StructuredError } from "../shared/contracts.js";
import type { BudgetSnapshot } from "../policy/budget-contracts.js";

export type SessionLifecycle =
  | "CREATED"
  | "RUNNING"
  | "WAITING_USER"
  | "WAITING_APPROVAL"
  | "VERIFYING"
  | "COMPLETION_CLAIMED"
  | "COMPLETION_VERIFIED"
  | "CANCELLING"
  | "CANCELLED"
  | "FAILED"
  | "UNKNOWN";

export type BudgetSummary = BudgetSnapshot;

export interface PendingApproval {
  readonly approvalId: string;
  readonly toolName: string;
  readonly operationHash: string;
}

export interface SessionView {
  readonly sessionId: StableId;
  readonly status: SessionLifecycle;
  readonly goal: string | null;
  readonly plan: readonly string[];
  readonly planRevision: number;
  readonly planChangeReason: string | null;
  readonly activeOperation: string | null;
  readonly lastError: string | null;
  readonly lastErrorCategory: string | null;
  readonly verificationPassed: boolean | null;
  readonly budget: BudgetSummary | null;
  readonly pendingApproval: PendingApproval | null;
  readonly traceComplete: boolean;
  readonly lastSequence: number;
}

export interface TraceIntegrityReport {
  readonly complete: boolean;
  readonly eventCount: number;
  readonly sessionId: StableId | null;
  readonly firstGap: number | null;
  readonly firstInvalidSequence: number | null;
  readonly firstError: StructuredError | null;
}

export class StateReducerError extends Error {
  readonly details: StructuredError;

  constructor(details: StructuredError) {
    super(details.message);
    this.name = "StateReducerError";
    this.details = details;
  }
}

export class StateReducer {
  #state: ReducerState | null = null;
  #lastSequence = -1;

  apply(event: AgentEvent): SessionView {
    const parsed = parseAgentEvent(event);
    if (!parsed.ok) throw new StateReducerError(parsed.error);
    const next = parsed.value;

    if (this.#state === null) {
      if (next.type !== "session.created" || next.sequence !== 0) {
        throw reducerError(
          "event_invalid_transition",
          "The first applied event must be session.created at sequence 0.",
          "Start the reducer from the beginning of the Session trace.",
        );
      }
      this.#state = initialState(next);
      this.#lastSequence = next.sequence;
      return this.#state.view;
    }
    if (next.sessionId !== this.#state.view.sessionId) {
      throw reducerError("cross_session_event", "Cannot apply an event from another Session.", "Use one reducer instance per Session.");
    }
    if (next.sequence !== this.#lastSequence + 1) {
      throw reducerError(
        "event_sequence_invalid",
        `Expected sequence ${this.#lastSequence + 1}, received ${next.sequence}.`,
        "Load the missing event before applying later facts.",
      );
    }
    this.#state = applyEvent(this.#state, next);
    this.#lastSequence = next.sequence;
    return this.#state.view;
  }

  snapshot(): SessionView | null {
    return this.#state?.view ?? null;
  }
}

interface ActiveOperation {
  readonly key: string;
  readonly name: string;
  readonly kind: "model" | "tool";
}

interface ReducerState {
  readonly view: SessionView;
  readonly activeOperations: Map<string, ActiveOperation>;
  readonly verifying: boolean;
}

export function reduceAgentEvents(events: readonly AgentEvent[]): SessionView | null {
  const integrity = checkTraceIntegrity(events);
  if (!integrity.complete) {
    throw new StateReducerError(
      integrity.firstError ?? eventError(
        "trace_incomplete",
        "The event trace is incomplete.",
        "Restore the missing facts before projecting session state.",
      ),
    );
  }
  return reduceParsedEvents(events);
}

export function checkTraceIntegrity(events: readonly unknown[]): TraceIntegrityReport {
  const parsed: AgentEvent[] = [];
  const eventIds = new Set<StableId>();
  let sessionId: StableId | null = null;
  let expectedSequence = 0;
  let firstGap: number | null = null;
  let firstInvalidSequence: number | null = null;

  for (const rawEvent of events) {
    const parsedEvent = parseAgentEvent(rawEvent);
    if (!parsedEvent.ok) {
      return incompleteReport(
        parsed.length,
        sessionId,
        firstGap,
        firstInvalidSequence,
        parsedEvent.error,
      );
    }

    const event = parsedEvent.value;
    if (sessionId === null) sessionId = event.sessionId;
    if (event.sessionId !== sessionId) {
      return incompleteReport(
        parsed.length,
        sessionId,
        firstGap,
        firstInvalidSequence,
        eventError(
          "cross_session_event",
          `Event ${event.eventId} belongs to a different session.`,
          "Load and reduce one Session at a time.",
        ),
      );
    }
    if (eventIds.has(event.eventId)) {
      return incompleteReport(
        parsed.length,
        sessionId,
        firstGap,
        firstInvalidSequence,
        eventError(
          "event_duplicate_id",
          `Event ID ${event.eventId} occurs more than once in the trace.`,
          "Keep only the first persisted fact and re-run the trace check.",
        ),
      );
    }
    eventIds.add(event.eventId);

    if (event.sequence > expectedSequence && firstGap === null) {
      firstGap = expectedSequence;
    }
    if (event.sequence < expectedSequence && firstInvalidSequence === null) {
      firstInvalidSequence = event.sequence;
    }
    if (event.sequence < expectedSequence) {
      return incompleteReport(
        parsed.length,
        sessionId,
        firstGap,
        firstInvalidSequence,
        eventError(
          "event_sequence_invalid",
          `Event sequence ${event.sequence} is not after ${expectedSequence - 1}.`,
          "Reload the session and preserve append order before replaying.",
        ),
      );
    }
    expectedSequence = event.sequence + 1;
    parsed.push(event);
  }

  if (firstGap !== null) {
    return incompleteReport(
      parsed.length,
      sessionId,
      firstGap,
      firstInvalidSequence,
      eventError(
        "trace_incomplete",
        `The first missing event sequence is ${firstGap}.`,
        "Restore or explicitly account for the missing fact before completion.",
      ),
    );
  }

  try {
    reduceParsedEvents(parsed);
  } catch (error: unknown) {
    if (error instanceof StateReducerError) {
      return incompleteReport(
        parsed.length,
        sessionId,
        firstGap,
        firstInvalidSequence,
        error.details,
      );
    }
    return incompleteReport(
      parsed.length,
      sessionId,
      firstGap,
      firstInvalidSequence,
      eventError(
        "reducer_failed",
        error instanceof Error ? error.message : String(error),
        "Keep the immutable facts and investigate the reducer failure.",
      ),
    );
  }

  return {
    complete: true,
    eventCount: parsed.length,
    sessionId,
    firstGap: null,
    firstInvalidSequence: null,
    firstError: null,
  };
}

function reduceParsedEvents(events: readonly AgentEvent[]): SessionView | null {
  const reducer = new StateReducer();
  for (const event of events) reducer.apply(event);
  return reducer.snapshot();
}

function initialState(first: AgentEvent): ReducerState {
  return {
    view: {
      sessionId: first.sessionId,
      status: "CREATED",
      goal: readString(first.payload, "goal"),
      plan: [],
      planRevision: 0,
      planChangeReason: null,
      activeOperation: null,
      lastError: null,
      lastErrorCategory: null,
      verificationPassed: null,
      budget: first.context.budgetSnapshot ?? null,
      pendingApproval: null,
      traceComplete: true,
      lastSequence: first.sequence,
    },
    activeOperations: new Map(),
    verifying: false,
  };
}

function applyEvent(state: ReducerState, event: AgentEvent): ReducerState {
  const view = withContext(state.view, event);
  const current = state.view.status;

  switch (event.type) {
    case "session.created":
      throw invalidTransition(current, event.type);
    case "session.started":
      if (current === "CREATED") return withView(state, { ...view, status: "RUNNING" });
      throw invalidTransition(current, event.type);
    case "plan.updated": {
      requireStatus(current, event.type, ["RUNNING"]);
      const revision = readNonNegativeInteger(event.payload, "revision");
      const reason = readString(event.payload, "reason");
      const steps = readStringArray(event.payload, "steps");
      if (revision === null || !reason || steps === null || revision <= state.view.planRevision) {
        throw reducerError(
          "event_payload_invalid",
          "plan.updated requires an increasing revision, non-empty reason and string steps.",
          "Re-emit the plan with a new revision and an explicit change reason.",
        );
      }
      return withView(state, {
        ...view,
        plan: steps,
        planRevision: revision,
        planChangeReason: reason,
      });
    }
    case "user.input.requested":
      requireStatus(current, event.type, ["RUNNING"]);
      return withView(state, { ...view, status: "WAITING_USER" });
    case "user.input.received":
      requireStatus(current, event.type, ["WAITING_USER"]);
      return withView(state, { ...view, status: "RUNNING" });
    case "model.started":
      requireStatus(current, event.type, ["RUNNING"]);
      return startOperation(state, event, "model", view);
    case "model.completed":
      requireStatus(current, event.type, ["RUNNING"]);
      return finishOperation(state, event, "model", view);
    case "tool.started":
      requireStatus(current, event.type, ["RUNNING"]);
      return startOperation(state, event, "tool", view);
    case "tool.completed":
      requireStatus(current, event.type, ["RUNNING"]);
      return finishOperation(state, event, "tool", view);
    case "tool.failed":
      requireStatus(current, event.type, ["RUNNING"]);
      return finishOperation(state, event, "tool", withError(view, event, "tool_failed"));
    case "approval.requested": {
      requireStatus(current, event.type, ["RUNNING"]);
      const pendingApproval = readPendingApproval(event);
      return withView(state, { ...view, status: "WAITING_APPROVAL", pendingApproval });
    }
    case "approval.resolved":
      requireStatus(current, event.type, ["WAITING_APPROVAL"]);
      ensureApprovalMatches(state.view.pendingApproval, event);
      return withView(state, { ...view, status: "RUNNING", pendingApproval: null });
    case "verification.started":
      requireStatus(current, event.type, ["RUNNING"]);
      if (state.verifying) throw reducerError("event_invalid_transition", "A verification is already active.", "Complete the active verification before starting another.");
      return withView({ ...state, verifying: true }, { ...view, status: "VERIFYING", verificationPassed: null });
    case "verification.completed": {
      requireStatus(current, event.type, ["VERIFYING"]);
      if (!state.verifying) throw reducerError("event_invalid_transition", "No verification is active.", "Append verification.started before its result.");
      const passed = readBooleanValue(event.payload, "passed");
      if (passed === null) throw invalidPayload(event.type, "verification.completed requires a boolean passed field.");
      return withView({ ...state, verifying: false }, {
        ...withOptionalError(view, event, passed ? null : "verification_failed"),
        status: passed ? "RUNNING" : "FAILED",
        verificationPassed: passed,
      });
    }
    case "completion.claimed":
      requireStatus(current, event.type, ["RUNNING"]);
      if (state.activeOperations.size > 0) {
        throw reducerError("event_invalid_transition", "Completion cannot be claimed while an operation is active.", "Finish or reconcile all active operations first.");
      }
      return withView(state, { ...view, status: "COMPLETION_CLAIMED" });
    case "completion.verified":
      requireStatus(current, event.type, ["COMPLETION_CLAIMED"]);
      return withView(state, { ...view, status: "COMPLETION_VERIFIED" });
    case "completion.rejected":
      requireStatus(current, event.type, ["COMPLETION_CLAIMED"]);
      return withView(state, { ...withError(view, event, "completion_rejected"), status: "RUNNING" });
    case "operation.unknown":
      requireStatus(current, event.type, ["RUNNING"]);
      requireUnknownOperation(event);
      return markUnknownOperation(state, event, view);
    case "operation.reconciled":
      requireStatus(current, event.type, ["UNKNOWN"]);
      return reconcileOperation(state, event, view);
    case "budget.updated":
      if (["COMPLETION_VERIFIED", "CANCELLED", "FAILED"].includes(current)) {
        throw invalidTransition(current, event.type);
      }
      if (event.context.budgetSnapshot === null || event.context.budgetSnapshot === undefined) {
        throw invalidPayload(event.type, "budget.updated requires a versioned C04 budget snapshot.");
      }
      return withView(state, { ...view, budget: event.context.budgetSnapshot });
    case "session.cancelling":
      if (["COMPLETION_VERIFIED", "CANCELLED", "FAILED"].includes(current)) {
        throw invalidTransition(current, event.type);
      }
      return withView(state, { ...view, status: "CANCELLING" });
    case "session.cancelled":
      requireStatus(current, event.type, ["CANCELLING"]);
      return withView({ ...state, activeOperations: new Map(), verifying: false }, { ...view, status: "CANCELLED", activeOperation: null, pendingApproval: null });
    case "session.failed":
      if (["COMPLETION_VERIFIED", "CANCELLED", "FAILED"].includes(current)) {
        throw invalidTransition(current, event.type);
      }
      return withView({ ...state, activeOperations: new Map(), verifying: false }, { ...withError(view, event, "session_failed"), status: "FAILED", activeOperation: null });
  }
}

function startOperation(
  state: ReducerState,
  event: AgentEvent,
  kind: "model" | "tool",
  view: SessionView,
): ReducerState {
  const operation = event.context.operation;
  if (!operation || operation.kind !== kind || operation.status !== "running") {
    throw invalidPayload(event.type, `${event.type} requires a running ${kind} operation context.`);
  }
  const key = operationKey(event);
  if (state.activeOperations.has(key)) {
    throw reducerError("event_operation_mismatch", `Operation ${operation.name} started more than once.`, "Use one started fact per operation hash or span.");
  }
  const activeOperations = new Map(state.activeOperations);
  activeOperations.set(key, { key, name: operation.name, kind });
  return withView({ ...state, activeOperations }, { ...view, activeOperation: operation.name });
}

function finishOperation(
  state: ReducerState,
  event: AgentEvent,
  kind: "model" | "tool",
  view: SessionView,
): ReducerState {
  const operation = event.context.operation;
  if (!operation || operation.kind !== kind || !["completed", "failed", "cancelled"].includes(operation.status)) {
    throw invalidPayload(event.type, `${event.type} requires a completed, failed or cancelled ${kind} operation context.`);
  }
  const key = operationKey(event);
  const active = state.activeOperations.get(key);
  if (!active || active.kind !== kind || active.name !== operation.name) {
    throw reducerError("event_operation_mismatch", `No matching started ${kind} operation exists for ${operation.name}.`, "Bind started and finished facts to the same operation hash or span.");
  }
  const activeOperations = new Map(state.activeOperations);
  activeOperations.delete(key);
  return withView({ ...state, activeOperations }, { ...view, activeOperation: lastOperationName(activeOperations) });
}

function reconcileOperation(state: ReducerState, event: AgentEvent, view: SessionView): ReducerState {
  const outcome = readString(event.payload, "outcome");
  const externalId = readString(event.payload, "externalId");
  if (!externalId || !outcome || !["applied", "not_applied", "unknown"].includes(outcome)) {
    throw invalidPayload(event.type, "operation.reconciled requires externalId and applied/not_applied/unknown outcome.");
  }
  if (outcome === "unknown") return withView(state, { ...withError(view, event, "external_state_unknown"), status: "UNKNOWN" });
  const activeOperations = new Map(state.activeOperations);
  activeOperations.delete(operationKey(event));
  return withView({ ...state, activeOperations }, { ...view, status: "RUNNING", activeOperation: lastOperationName(activeOperations) });
}

function markUnknownOperation(state: ReducerState, event: AgentEvent, view: SessionView): ReducerState {
  const operation = event.context.operation;
  const activeOperations = new Map(state.activeOperations);
  if (operation && (operation.kind === "model" || operation.kind === "tool")) {
    const key = operationKey(event);
    activeOperations.set(key, { key, name: operation.name, kind: operation.kind });
  }
  return withView(
    { ...state, activeOperations },
    {
      ...withError(view, event, "external_state_unknown"),
      status: "UNKNOWN",
      activeOperation: operation?.name ?? view.activeOperation,
    },
  );
}

function operationKey(event: AgentEvent): string {
  const operationHash = event.context.operation?.operationHash ?? readString(event.payload, "operationHash");
  return operationHash ? `hash:${operationHash}` : `span:${event.spanId}`;
}

function readPendingApproval(event: AgentEvent): PendingApproval {
  const authorization = event.context.authorization;
  const approvalId = authorization?.approvalId ?? readString(event.payload, "approvalId");
  const toolName = readString(event.payload, "toolName") ?? event.context.operation?.name;
  const operationHash = readString(event.payload, "operationHash") ?? event.context.operation?.operationHash;
  if (!approvalId || !toolName || !operationHash) {
    throw invalidPayload(event.type, "approval.requested requires approvalId, toolName and operationHash.");
  }
  return { approvalId, toolName, operationHash };
}

function ensureApprovalMatches(pending: PendingApproval | null, event: AgentEvent): void {
  if (!pending) throw reducerError("event_invalid_transition", "No approval is pending.", "Append approval.requested before approval.resolved.");
  const approvalId = event.context.authorization?.approvalId ?? readString(event.payload, "approvalId");
  if (!approvalId || approvalId !== pending.approvalId) {
    throw reducerError("event_payload_invalid", "approval.resolved references a different approval.", "Resolve the currently pending approval only.");
  }
  const operationHash = event.context.operation?.operationHash ?? readString(event.payload, "operationHash");
  if (operationHash !== null && operationHash !== pending.operationHash) {
    throw reducerError("event_payload_invalid", "approval.resolved references a different operation.", "Resolve the approval for the currently pending operation only.");
  }
}

function requireUnknownOperation(event: AgentEvent): void {
  const operation = event.context.operation;
  const externalId = readString(event.payload, "externalId");
  const recovery = event.context.error?.recovery ?? readString(event.payload, "recovery");
  if (!operation || operation.status !== "unknown" || !externalId || !recovery) {
    throw invalidPayload(event.type, "operation.unknown requires operation name/status, externalId and recovery guidance.");
  }
}

function withContext(view: SessionView, event: AgentEvent): SessionView {
  return {
    ...view,
    lastSequence: event.sequence,
    budget: event.context.budgetSnapshot ?? view.budget,
  };
}

function withView(state: ReducerState, view: SessionView): ReducerState {
  return { ...state, view };
}

function withError(view: SessionView, event: AgentEvent, fallbackCategory: string): SessionView {
  const message = event.context.error?.message ?? readString(event.payload, "message") ?? "Event reported an error.";
  const category = event.context.error?.category ?? readString(event.payload, "category") ?? fallbackCategory;
  return { ...view, lastError: message, lastErrorCategory: category };
}

function withOptionalError(view: SessionView, event: AgentEvent, fallbackCategory: string | null): SessionView {
  return fallbackCategory === null ? view : withError(view, event, fallbackCategory);
}

function lastOperationName(operations: Map<string, ActiveOperation>): string | null {
  return [...operations.values()].at(-1)?.name ?? null;
}

function requireStatus(
  current: SessionLifecycle,
  eventType: AgentEvent["type"],
  allowed: readonly SessionLifecycle[],
): void {
  if (!allowed.includes(current)) throw invalidTransition(current, eventType);
}

function invalidTransition(current: SessionLifecycle, eventType: AgentEvent["type"]): StateReducerError {
  return reducerError(
    "event_invalid_transition",
    `Event ${eventType} is not valid while Session is ${current}.`,
    "Append a lifecycle event allowed by the Session state machine.",
  );
}

function invalidPayload(eventType: AgentEvent["type"], message: string): StateReducerError {
  return reducerError(
    "event_payload_invalid",
    `${eventType}: ${message}`,
    "Emit the event again with the required structured fields.",
  );
}

function reducerError(category: string, message: string, recovery: string): StateReducerError {
  return new StateReducerError(eventError(category, message, recovery));
}

function eventError(category: string, message: string, recovery: string): StructuredError {
  return {
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  };
}

function incompleteReport(
  eventCount: number,
  sessionId: StableId | null,
  firstGap: number | null,
  firstInvalidSequence: number | null,
  firstError: StructuredError,
): TraceIntegrityReport {
  return { complete: false, eventCount, sessionId, firstGap, firstInvalidSequence, firstError };
}

function readString(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBooleanValue(payload: JsonObject, key: string): boolean | null {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

function readNonNegativeInteger(payload: JsonObject, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readStringArray(payload: JsonObject, key: string): readonly string[] | null {
  const value = payload[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    ? value
    : null;
}
