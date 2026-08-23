import type { AgentEvent, AgentEventType } from "./agent-event.js";
import type { BudgetDelta } from "../policy/budget-contracts.js";
import type {
  SideEffectStatus,
  StableId,
  StructuredError,
  ToolRisk,
  UsageRecord,
  UtcTimestamp,
} from "../shared/contracts.js";
import type { JsonObject } from "../shared/json.js";

export interface ExecutionIdentity {
  readonly sessionId: StableId;
  readonly taskId: StableId;
  readonly traceId: StableId;
  readonly workspacePath: string;
  readonly codeVersion: string | null;
  readonly diffHash: string | null;
  readonly configVersion: string;
  readonly actorId?: string;
  readonly parentTaskId?: StableId | null;
}

export interface BeginExecutionInput {
  readonly identity: ExecutionIdentity;
  readonly kind: "model" | "tool";
  readonly name: string;
  readonly operationHash: string;
  readonly estimate: BudgetDelta;
  readonly authorization?: {
    readonly risk: ToolRisk;
    readonly authorizationId: StableId | null;
    readonly approvalId: StableId | null;
  } | null;
  readonly approvalToConsume?: {
    readonly approvalId: StableId;
    readonly operationHash: string;
  } | null;
  readonly payload?: JsonObject;
}

export interface ExecutionLease {
  readonly operationId: StableId;
  readonly reservationId: StableId;
  readonly spanId: StableId;
  readonly identity: ExecutionIdentity;
  readonly kind: "model" | "tool";
  readonly name: string;
  readonly operationHash: string;
  readonly authorization: NonNullable<BeginExecutionInput["authorization"]> | null;
  readonly startedAt: UtcTimestamp;
}

export interface FinishExecutionInput {
  readonly lease: ExecutionLease;
  readonly status: "completed" | "failed" | "cancelled";
  readonly actual: BudgetDelta | null;
  readonly usage?: UsageRecord | null;
  readonly sideEffectStatus: SideEffectStatus;
  readonly error?: StructuredError | null;
  readonly payload?: JsonObject;
}

export interface AppendExecutionEventInput {
  readonly identity: ExecutionIdentity;
  readonly type: AgentEventType;
  readonly payload?: JsonObject;
  readonly error?: StructuredError | null;
}

/** C08/C11 persistence boundary. Implementations acknowledge only committed facts. */
export interface ExecutionJournal {
  append(input: AppendExecutionEventInput): Promise<AgentEvent>;
  begin(input: BeginExecutionInput): Promise<ExecutionLease>;
  finish(input: FinishExecutionInput): Promise<AgentEvent>;
}
