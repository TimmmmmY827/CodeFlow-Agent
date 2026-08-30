import { createAgentEvent, createEventContext, type AgentEvent } from "../../events/agent-event.js";
import type {
  AppendExecutionEventInput,
  BeginExecutionInput,
  ExecutionJournal,
  ExecutionLease,
  FinishExecutionInput,
} from "../../events/execution-journal.js";
import type { TransactionalBudgetLedger } from "../../policy/budget-contracts.js";
import type { SqliteApprovalRepository } from "./sqlite-approval-repository.js";
import { createStableId, type StableId } from "../../shared/contracts.js";
import type { JsonObject } from "../../shared/json.js";
import type { SqliteBudgetLedger } from "./sqlite-budget-ledger.js";
import type { SqliteStorageDatabase } from "./sqlite-database.js";
import { storageError } from "./sqlite-errors.js";
import type { SqliteEventStore } from "./sqlite-event-store.js";

export class SqliteExecutionJournal implements ExecutionJournal {
  readonly #ledger: TransactionalBudgetLedger;

  constructor(
    private readonly storage: SqliteStorageDatabase,
    private readonly eventStore: SqliteEventStore,
    ledger: SqliteBudgetLedger,
    private readonly approvals: SqliteApprovalRepository | null = null,
  ) {
    this.#ledger = ledger;
  }

  async append(input: AppendExecutionEventInput): Promise<AgentEvent> {
    const event = this.storage.runImmediateTransaction(() => {
      const fact = createAgentEvent({
        ...eventIdentity(input),
        sequence: this.#nextSequence(input.identity.sessionId),
        occurredAt: this.storage.clock.utcNow(),
        type: input.type,
        context: createEventContext({
          workspacePath: input.identity.workspacePath,
          codeVersion: input.identity.codeVersion,
          diffHash: input.identity.diffHash,
          configVersion: input.identity.configVersion,
          error: input.error ?? null,
          sideEffectStatus: input.error?.sideEffectStatus ?? "none",
        }),
        payload: input.payload ?? {},
      });
      this.eventStore.appendWithinTransaction(fact);
      return fact;
    });
    await this.eventStore.notifyCommitted(event);
    return event;
  }

  async begin(input: BeginExecutionInput): Promise<ExecutionLease> {
    assertAuthorizationAdmission(input);
    const operationId = createStableId();
    const reservationId = createStableId();
    const spanId = createStableId();
    const startedAt = this.storage.clock.utcNow();
    const committed = this.storage.runImmediateTransaction(() => {
      if (input.approvalToConsume) {
        if (!this.approvals) {
          throw storageError(
            "approval_repository_unavailable",
            "The execution journal cannot consume the required durable approval.",
            false,
            "Construct the journal with the approval repository from the same storage transaction host.",
          );
        }
        this.approvals.consumeWithinTransaction(input.approvalToConsume);
      }
      const reservation = this.#ledger.reserveWithinTransaction({
        entryId: reservationId,
        sessionId: input.identity.sessionId,
        operationId,
        idempotencyKey: `execution:${operationId}:reserve`,
        delta: input.estimate,
      });
      const event = createAgentEvent({
        ...eventIdentity({ identity: input.identity }),
        spanId,
        sequence: this.#nextSequence(input.identity.sessionId),
        occurredAt: startedAt,
        type: input.kind === "model" ? "model.started" : "tool.started",
        context: createEventContext({
          workspacePath: input.identity.workspacePath,
          codeVersion: input.identity.codeVersion,
          diffHash: input.identity.diffHash,
          configVersion: input.identity.configVersion,
          operation: {
            kind: input.kind,
            name: input.name,
            status: "running",
            durationMs: null,
            operationHash: input.operationHash,
          },
          authorization: input.authorization ?? null,
          budgetSnapshot: reservation.snapshot,
        }),
        payload: operationPayload(input.payload, operationId, input.operationHash),
      });
      this.eventStore.appendWithinTransaction(event);
      return { event, lease: { operationId, reservationId, spanId, identity: input.identity, kind: input.kind, name: input.name, operationHash: input.operationHash, authorization: input.authorization ?? null, startedAt } satisfies ExecutionLease };
    });
    await this.eventStore.notifyCommitted(committed.event);
    return committed.lease;
  }

  async finish(input: FinishExecutionInput): Promise<AgentEvent> {
    const occurredAt = this.storage.clock.utcNow();
    const durationMs = Math.max(0, Date.parse(occurredAt) - Date.parse(input.lease.startedAt));
    const event = this.storage.runImmediateTransaction(() => {
      const committed = this.#ledger.commitWithinTransaction({
        entryId: createStableId(),
        sessionId: input.lease.identity.sessionId,
        operationId: input.lease.operationId,
        idempotencyKey: `execution:${input.lease.operationId}:commit`,
        reservationId: input.lease.reservationId,
        actual: input.actual,
      });
      const fact = createAgentEvent({
        ...eventIdentity({ identity: input.lease.identity }),
        spanId: input.lease.spanId,
        sequence: this.#nextSequence(input.lease.identity.sessionId),
        occurredAt,
        type: input.lease.kind === "model"
          ? "model.completed"
          : input.status === "completed" ? "tool.completed" : "tool.failed",
        context: createEventContext({
          workspacePath: input.lease.identity.workspacePath,
          codeVersion: input.lease.identity.codeVersion,
          diffHash: input.lease.identity.diffHash,
          configVersion: input.lease.identity.configVersion,
          operation: {
            kind: input.lease.kind,
            name: input.lease.name,
            status: input.status,
            durationMs,
            operationHash: input.lease.operationHash,
          },
          authorization: input.lease.authorization,
          usage: input.usage ?? null,
          error: input.error ?? null,
          sideEffectStatus: input.sideEffectStatus,
          budgetSnapshot: committed.snapshot,
        }),
        payload: operationPayload(input.payload, input.lease.operationId, input.lease.operationHash),
      });
      this.eventStore.appendWithinTransaction(fact);
      return fact;
    });
    await this.eventStore.notifyCommitted(event);
    return event;
  }

  #nextSequence(sessionId: string): number {
    const row = this.storage.database
      .prepare("SELECT last_sequence, deletion_state FROM sessions WHERE session_id = ?")
      .get(sessionId);
    if (!row || row.deletion_state !== "active" || typeof row.last_sequence !== "number" || !Number.isSafeInteger(row.last_sequence)) {
      throw storageError(
        "session_not_writable",
        `Session ${sessionId} cannot accept an execution fact.`,
        false,
        "Create or restore an active Session before running the agent.",
      );
    }
    return row.last_sequence + 1;
  }
}

function assertAuthorizationAdmission(input: BeginExecutionInput): void {
  const authorization = input.authorization ?? null;
  const approval = input.approvalToConsume ?? null;
  if (input.kind === "model") {
    if (authorization !== null || approval !== null) {
      throw invalidAuthorization("Model attempts cannot carry tool authorization evidence.");
    }
    return;
  }
  if (authorization === null) {
    throw invalidAuthorization("Tool attempts require an authorization decision fact.");
  }
  switch (authorization.risk) {
    case "automatic":
    case "control":
      if (authorization.authorizationId !== null || authorization.approvalId !== null || approval !== null) {
        throw invalidAuthorization("Fixed-policy tools cannot consume task or approval evidence.");
      }
      return;
    case "task_authorized":
      if (authorization.authorizationId === null || authorization.approvalId !== null || approval !== null) {
        throw invalidAuthorization("Task-authorized tools require exactly one task authorization reference.");
      }
      return;
    case "single_confirmation":
      if (
        authorization.authorizationId !== null ||
        authorization.approvalId === null ||
        approval === null ||
        approval.approvalId !== authorization.approvalId ||
        approval.operationHash !== input.operationHash
      ) {
        throw invalidAuthorization("Single-confirmation tools require a matching approval consumption request.");
      }
      return;
  }
}

function invalidAuthorization(message: string): ReturnType<typeof storageError> {
  return storageError(
    "authorization_context_invalid",
    message,
    false,
    "Rebuild the execution admission from the current PermissionEngine decision.",
  );
}

function eventIdentity(input: Pick<AppendExecutionEventInput, "identity">): {
  sessionId: AppendExecutionEventInput["identity"]["sessionId"];
  taskId: AppendExecutionEventInput["identity"]["taskId"];
  traceId: AppendExecutionEventInput["identity"]["traceId"];
  actorId: string;
  parentTaskId: StableId | null;
} {
  return {
    sessionId: input.identity.sessionId,
    taskId: input.identity.taskId,
    traceId: input.identity.traceId,
    actorId: input.identity.actorId ?? "agent:primary",
    parentTaskId: input.identity.parentTaskId ?? null,
  };
}

function operationPayload(
  payload: JsonObject | undefined,
  operationId: string,
  operationHash: string,
): JsonObject {
  return { ...(payload ?? {}), operationId, operationHash };
}
