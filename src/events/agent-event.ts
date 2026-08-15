import { z } from "zod";

import {
  codeSnapshotSchema,
  createCodeSnapshot,
  createStableId,
  createUtcTimestamp,
  sideEffectStatusSchema,
  stableIdSchema,
  structuredErrorSchema,
  toolRiskSchema,
  usageRecordSchema,
  utcTimestampSchema,
  type StableId,
  type StructuredError,
  type UsageRecord,
} from "../shared/contracts.js";
import { isJsonValue, type JsonObject } from "../shared/json.js";
import type { Result } from "../shared/result.js";
import { parseVersionedSchema } from "../shared/versioned-schema.js";
import { budgetSnapshotSchema } from "../policy/budget-contracts.js";

export const AGENT_EVENT_SCHEMA_VERSION = 1;

export const agentEventTypeSchema = z.enum([
  "session.created",
  "session.started",
  "plan.updated",
  "user.input.requested",
  "user.input.received",
  "model.started",
  "model.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "verification.started",
  "verification.completed",
  "completion.claimed",
  "completion.verified",
  "completion.rejected",
  "operation.unknown",
  "operation.reconciled",
  "budget.updated",
  "session.cancelling",
  "session.cancelled",
  "session.failed",
]);

export type AgentEventType = z.infer<typeof agentEventTypeSchema>;

export const eventContextSchema = z
  .object({
    ...codeSnapshotSchema.shape,
    operation: z
      .object({
        kind: z.enum(["system", "model", "tool", "control"]),
        name: z.string().min(1),
        status: z.enum(["pending", "running", "completed", "failed", "cancelled", "unknown"]),
        durationMs: z.number().nonnegative().nullable(),
        operationHash: z.string().min(1).nullable().optional(),
      })
      .nullable(),
    usage: usageRecordSchema.nullable(),
    authorization: z
      .object({
        risk: toolRiskSchema,
        authorizationId: z.string().min(1).nullable(),
        approvalId: z.string().min(1).nullable(),
      })
      .nullable(),
    error: structuredErrorSchema.nullable(),
    sideEffectStatus: sideEffectStatusSchema,
    budget: z
      .object({
        usage: z
          .object({
            steps: z.number().int().nonnegative(),
            toolCalls: z.number().int().nonnegative(),
            durationMs: z.number().nonnegative(),
            costUsd: z.number().nonnegative(),
          }),
        limits: z
          .object({
            maxSteps: z.number().int().positive(),
            maxToolCalls: z.number().int().positive(),
            maxDurationMs: z.number().positive(),
            maxCostUsd: z.number().nonnegative(),
          }),
      })
      .nullable()
      .default(null),
    // Additive v1 field: optional preserves canonical round-trip for events
    // persisted before C04 introduced the versioned snapshot.
    budgetSnapshot: budgetSnapshotSchema.nullable().optional(),
  })
  .superRefine((context, refinement) => {
    if (context.diffHash !== null && context.codeVersion === null) {
      refinement.addIssue({
        code: "custom",
        message: "A diff hash requires a Git or controlled workspace code version.",
        path: ["codeVersion"],
      });
    }
    if (context.error && context.error.sideEffectStatus !== context.sideEffectStatus) {
      refinement.addIssue({
        code: "custom",
        message: "Error and event side-effect status must match.",
        path: ["error", "sideEffectStatus"],
      });
    }
  });

export type AgentEventContext = z.infer<typeof eventContextSchema>;

export const agentEventSchema = z.object({
  schemaVersion: z.literal(AGENT_EVENT_SCHEMA_VERSION),
  eventId: stableIdSchema,
  sessionId: stableIdSchema,
  taskId: stableIdSchema,
  actorId: z.string().min(1),
  parentTaskId: stableIdSchema.nullable(),
  traceId: stableIdSchema,
  spanId: stableIdSchema,
  parentSpanId: stableIdSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  occurredAt: utcTimestampSchema,
  type: agentEventTypeSchema,
  context: eventContextSchema,
  payload: z.custom<JsonObject>(
    (value) => isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === "object",
    "AgentEvent payload must be a JSON object.",
  ),
});

export type AgentEvent = z.infer<typeof agentEventSchema>;

export interface CreateAgentEventInput {
  readonly sessionId: StableId;
  readonly taskId: StableId;
  readonly actorId?: string;
  readonly parentTaskId?: StableId | null;
  readonly traceId?: StableId;
  readonly spanId?: StableId;
  readonly parentSpanId?: StableId | null;
  readonly sequence: number;
  readonly type: AgentEventType;
  readonly context: AgentEventContext;
  readonly payload?: JsonObject;
  readonly occurredAt?: string;
}

type UsageRecordInput = Omit<UsageRecord, "durationMs" | "providerUsage"> &
  Partial<Pick<UsageRecord, "durationMs" | "providerUsage">>;

export interface CreateEventContextInput {
  readonly workspacePath: string;
  readonly codeVersion?: string | null;
  readonly diffHash?: string | null;
  readonly configVersion?: string;
  readonly operation?: AgentEventContext["operation"];
  readonly usage?: UsageRecordInput | null;
  readonly authorization?: AgentEventContext["authorization"];
  readonly error?: StructuredError | null;
  readonly sideEffectStatus?: AgentEventContext["sideEffectStatus"];
  readonly budget?: AgentEventContext["budget"];
  readonly budgetSnapshot?: AgentEventContext["budgetSnapshot"];
}

export function createEventContext(input: CreateEventContextInput): AgentEventContext {
  const snapshot = createCodeSnapshot(input);
  return eventContextSchema.parse({
    ...snapshot,
    operation: input.operation ?? null,
    usage: input.usage
      ? {
          ...input.usage,
          durationMs: input.usage.durationMs ?? input.operation?.durationMs ?? 0,
          providerUsage: input.usage.providerUsage ?? {},
        }
      : null,
    authorization: input.authorization ?? null,
    error: input.error ?? null,
    sideEffectStatus: input.sideEffectStatus ?? "none",
    budget: input.budget ?? null,
    budgetSnapshot: input.budgetSnapshot ?? null,
  });
}

export function createAgentEvent(input: CreateAgentEventInput): AgentEvent {
  return agentEventSchema.parse({
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    eventId: createStableId(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    actorId: input.actorId ?? "agent:primary",
    parentTaskId: input.parentTaskId ?? null,
    traceId: input.traceId ?? createStableId(),
    spanId: input.spanId ?? createStableId(),
    parentSpanId: input.parentSpanId ?? null,
    sequence: input.sequence,
    occurredAt: input.occurredAt ?? createUtcTimestamp(),
    type: input.type,
    context: input.context,
    payload: input.payload ?? {},
  });
}

export function parseAgentEvent(input: unknown): Result<AgentEvent, StructuredError> {
  return parseVersionedSchema(
    "AgentEvent",
    AGENT_EVENT_SCHEMA_VERSION,
    agentEventSchema,
    input,
  );
}
