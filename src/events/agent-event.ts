import { randomUUID } from "node:crypto";
import { z } from "zod";

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
  "session.cancelling",
  "session.cancelled",
  "session.failed",
]);

export type AgentEventType = z.infer<typeof agentEventTypeSchema>;

export const eventContextSchema = z.object({
  workspacePath: z.string().min(1),
  codeVersion: z.string().min(1).nullable(),
  configVersion: z.string().min(1),
  operation: z
    .object({
      kind: z.enum(["system", "model", "tool", "control"]),
      name: z.string().min(1),
      status: z.enum(["pending", "running", "completed", "failed", "cancelled", "unknown"]),
      durationMs: z.number().nonnegative().nullable(),
    })
    .nullable(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    .nullable(),
  authorization: z
    .object({
      risk: z.enum(["automatic", "task_authorized", "single_confirmation", "control"]),
      authorizationId: z.string().min(1).nullable(),
      approvalId: z.string().min(1).nullable(),
    })
    .nullable(),
  error: z
    .object({
      category: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
      recovery: z.string().min(1).nullable(),
    })
    .nullable(),
  sideEffectStatus: z.enum(["none", "not_started", "applied", "unknown", "compensated"]),
});

export type AgentEventContext = z.infer<typeof eventContextSchema>;

export const agentEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  sessionId: z.string().uuid(),
  taskId: z.string().uuid(),
  actorId: z.string().min(1),
  parentTaskId: z.string().uuid().nullable(),
  traceId: z.string().uuid(),
  spanId: z.string().uuid(),
  parentSpanId: z.string().uuid().nullable(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  type: agentEventTypeSchema,
  context: eventContextSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type AgentEvent = z.infer<typeof agentEventSchema>;

export interface CreateAgentEventInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly actorId?: string;
  readonly parentTaskId?: string | null;
  readonly traceId?: string;
  readonly parentSpanId?: string | null;
  readonly sequence: number;
  readonly type: AgentEventType;
  readonly context: AgentEventContext;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}

export interface CreateEventContextInput {
  readonly workspacePath: string;
  readonly codeVersion?: string | null;
  readonly configVersion?: string;
  readonly operation?: AgentEventContext["operation"];
  readonly usage?: AgentEventContext["usage"];
  readonly authorization?: AgentEventContext["authorization"];
  readonly error?: AgentEventContext["error"];
  readonly sideEffectStatus?: AgentEventContext["sideEffectStatus"];
}

export function createEventContext(input: CreateEventContextInput): AgentEventContext {
  return eventContextSchema.parse({
    workspacePath: input.workspacePath,
    codeVersion: input.codeVersion ?? null,
    configVersion: input.configVersion ?? "config:unversioned",
    operation: input.operation ?? null,
    usage: input.usage ?? null,
    authorization: input.authorization ?? null,
    error: input.error ?? null,
    sideEffectStatus: input.sideEffectStatus ?? "none",
  });
}

export function createAgentEvent(input: CreateAgentEventInput): AgentEvent {
  return agentEventSchema.parse({
    schemaVersion: 1,
    eventId: randomUUID(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    actorId: input.actorId ?? "agent:primary",
    parentTaskId: input.parentTaskId ?? null,
    traceId: input.traceId ?? randomUUID(),
    spanId: randomUUID(),
    parentSpanId: input.parentSpanId ?? null,
    sequence: input.sequence,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    type: input.type,
    context: input.context,
    payload: input.payload ?? {},
  });
}
