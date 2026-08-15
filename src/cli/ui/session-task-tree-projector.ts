import type { AgentEvent } from "../../events/agent-event.js";
import { StateReducer, StateReducerError, type SessionLifecycle, type SessionView } from "../../events/state-reducer.js";
import type { BudgetSnapshot } from "../../policy/budget-contracts.js";
import type { StableId, StructuredError, UtcTimestamp } from "../../shared/contracts.js";
import { canonicalJson } from "../../shared/json.js";

export const SESSION_TASK_TREE_SCHEMA_VERSION = 1;

export type SessionOperationStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | "reconciled";

export interface SessionOperationNode {
  readonly spanId: StableId;
  readonly parentSpanId: StableId | null;
  readonly kind: "model" | "tool";
  readonly name: string;
  readonly status: SessionOperationStatus;
  readonly operationHash: string | null;
  readonly startedSequence: number;
  readonly finishedSequence: number | null;
  readonly durationMs: number | null;
  readonly error: StructuredError | null;
}

export interface SessionFirstError {
  readonly sequence: number;
  readonly category: string;
  readonly message: string;
}

export interface SessionTaskTreeViewModel {
  readonly schemaVersion: typeof SESSION_TASK_TREE_SCHEMA_VERSION;
  readonly sessionId: StableId;
  readonly goal: string | null;
  readonly workspacePath: string;
  readonly status: SessionLifecycle;
  readonly lastSequence: number;
  readonly traceComplete: boolean;
  readonly planRevision: number;
  readonly plan: readonly string[];
  readonly activeOperation: string | null;
  readonly operations: readonly SessionOperationNode[];
  readonly verificationPassed: boolean | null;
  readonly budget: BudgetSnapshot | null;
  readonly firstError: SessionFirstError | null;
  readonly updatedAt: UtcTimestamp;
}

export class SessionTaskTreeProjectionError extends Error {
  readonly details: StructuredError;

  constructor(details: StructuredError) {
    super(details.message);
    this.name = "SessionTaskTreeProjectionError";
    this.details = details;
  }
}

/** Incremental C13 projection. AgentEvent remains the fact source. */
export class SessionTaskTreeProjector {
  readonly #reducer = new StateReducer();
  readonly #eventCanonicalById = new Map<StableId, string>();
  readonly #eventIdBySequence = new Map<number, StableId>();
  readonly #operations = new Map<StableId, SessionOperationNode>();
  readonly #operationOrder: StableId[] = [];
  #workspacePath = "";
  #firstError: SessionFirstError | null = null;
  #view: SessionView | null = null;
  #updatedAt: UtcTimestamp | null = null;

  apply(event: AgentEvent): SessionTaskTreeViewModel {
    const canonical = canonicalJson(event);
    const existingCanonical = this.#eventCanonicalById.get(event.eventId);
    if (existingCanonical !== undefined) {
      if (existingCanonical !== canonical) {
        throw projectionError(
          "event_id_conflict",
          `Event ${event.eventId} was delivered again with different contents.`,
          "Stop rendering and inspect the persisted trace before reconnecting.",
        );
      }
      return this.snapshotRequired();
    }

    const sequenceOwner = this.#eventIdBySequence.get(event.sequence);
    if (sequenceOwner !== undefined) {
      throw projectionError(
        "event_sequence_conflict",
        `Sequence ${event.sequence} is already owned by event ${sequenceOwner}.`,
        "Reconnect from the last rendered sequence and inspect the conflicting fact.",
      );
    }

    try {
      this.#view = this.#reducer.apply(event);
    } catch (error: unknown) {
      if (error instanceof StateReducerError) throw new SessionTaskTreeProjectionError(error.details);
      throw error;
    }

    this.#eventCanonicalById.set(event.eventId, canonical);
    this.#eventIdBySequence.set(event.sequence, event.eventId);
    if (this.#workspacePath.length === 0) this.#workspacePath = event.context.workspacePath;
    this.#updatedAt = event.occurredAt;
    this.#applyOperation(event);
    if (this.#firstError === null && this.#view.lastError !== null) {
      this.#firstError = {
        sequence: event.sequence,
        category: this.#view.lastErrorCategory ?? "session_error",
        message: this.#view.lastError,
      };
    }
    return this.snapshotRequired();
  }

  snapshot(): SessionTaskTreeViewModel | null {
    return this.#view === null ? null : this.snapshotRequired();
  }

  #applyOperation(event: AgentEvent): void {
    const operation = event.context.operation;
    if (!operation || (operation.kind !== "model" && operation.kind !== "tool")) return;
    const operationHash = operation.operationHash ?? readPayloadString(event, "operationHash");

    if (event.type === "model.started" || event.type === "tool.started") {
      if (this.#operations.has(event.spanId)) {
        throw projectionError(
          "event_operation_mismatch",
          `Span ${event.spanId} contains more than one started operation.`,
          "Use a distinct span for every model or tool call.",
        );
      }
      this.#operations.set(event.spanId, {
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        kind: operation.kind,
        name: operation.name,
        status: "running",
        operationHash,
        startedSequence: event.sequence,
        finishedSequence: null,
        durationMs: null,
        error: null,
      });
      this.#operationOrder.push(event.spanId);
      return;
    }

    if (!["model.completed", "tool.completed", "tool.failed", "operation.unknown", "operation.reconciled"].includes(event.type)) return;
    const spanId = this.#findOperationSpan(event, operation.kind, operation.name, operationHash);
    const existing = spanId ? this.#operations.get(spanId) : undefined;
    if (!existing) {
      if (event.type !== "operation.unknown") return;
      this.#operations.set(event.spanId, {
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        kind: operation.kind,
        name: operation.name,
        status: "unknown",
        operationHash,
        startedSequence: event.sequence,
        finishedSequence: event.sequence,
        durationMs: operation.durationMs,
        error: event.context.error ?? null,
      });
      this.#operationOrder.push(event.spanId);
      return;
    }
    const status = event.type === "operation.unknown"
      ? "unknown"
      : event.type === "operation.reconciled"
        ? "reconciled"
        : operation.status === "cancelled"
          ? "cancelled"
          : operation.status === "failed" || event.type === "tool.failed"
            ? "failed"
            : "completed";
    this.#operations.set(existing.spanId, {
      ...existing,
      status,
      finishedSequence: event.sequence,
      durationMs: operation.durationMs,
      error: event.context.error ?? null,
    });
  }

  #findOperationSpan(
    event: AgentEvent,
    kind: "model" | "tool",
    name: string,
    operationHash: string | null,
  ): StableId | null {
    const exact = this.#operations.get(event.spanId);
    if (exact?.kind === kind && exact.name === name) return exact.spanId;
    if (!operationHash) return null;
    const matches = [...this.#operations.values()].filter((candidate) =>
      candidate.kind === kind &&
      candidate.name === name &&
      candidate.operationHash === operationHash &&
      (candidate.status === "running" || (event.type === "operation.reconciled" && candidate.status === "unknown"))
    );
    if (matches.length > 1) {
      throw projectionError(
        "event_operation_mismatch",
        `Operation ${name} has multiple candidate spans for the same operation hash.`,
        "Bind the terminal fact to the exact started operation span.",
      );
    }
    return matches.length === 1 ? matches[0]?.spanId ?? null : null;
  }

  private snapshotRequired(): SessionTaskTreeViewModel {
    const view = this.#view;
    const updatedAt = this.#updatedAt;
    if (!view || !updatedAt) {
      throw projectionError(
        "session_view_unavailable",
        "No Session event has been projected yet.",
        "Replay session.created before requesting a task tree snapshot.",
      );
    }
    return {
      schemaVersion: SESSION_TASK_TREE_SCHEMA_VERSION,
      sessionId: view.sessionId,
      goal: view.goal,
      workspacePath: this.#workspacePath,
      status: view.status,
      lastSequence: view.lastSequence,
      traceComplete: view.traceComplete,
      planRevision: view.planRevision,
      plan: [...view.plan],
      activeOperation: view.activeOperation,
      operations: this.#operationOrder.map((spanId) => this.#operations.get(spanId)).filter(isDefined),
      verificationPassed: view.verificationPassed,
      budget: view.budget,
      firstError: this.#firstError,
      updatedAt,
    };
  }
}

function readPayloadString(event: AgentEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function projectionError(category: string, message: string, recovery: string): SessionTaskTreeProjectionError {
  return new SessionTaskTreeProjectionError({
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  });
}
