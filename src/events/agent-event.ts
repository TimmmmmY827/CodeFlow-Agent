import { randomUUID } from "node:crypto";
import { z } from "zod";

export const agentEventTypeSchema = z.enum([
  "session.created",
  "session.started",
  "plan.updated",
  "model.started",
  "model.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "verification.started",
  "verification.completed",
  "session.cancelling",
  "session.cancelled",
  "session.failed",
  "session.completed",
]);

export type AgentEventType = z.infer<typeof agentEventTypeSchema>;

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
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
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
    payload: input.payload ?? {},
  });
}
