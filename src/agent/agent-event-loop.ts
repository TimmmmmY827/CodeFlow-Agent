import { randomUUID } from "node:crypto";

import { createAgentEvent } from "../events/agent-event.js";
import type { EventStore } from "../events/event-store.js";

export interface CreateSessionRequest {
  readonly goal: string;
  readonly workspace: string;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly taskId: string;
  readonly traceId: string;
}

export class AgentEventLoop {
  constructor(private readonly eventStore: EventStore) {}

  async createSession(request: CreateSessionRequest): Promise<CreatedSession> {
    const sessionId = randomUUID();
    const taskId = randomUUID();
    const traceId = randomUUID();
    await this.eventStore.append(
      createAgentEvent({
        sessionId,
        taskId,
        traceId,
        sequence: 0,
        type: "session.created",
        payload: { goal: request.goal, workspace: request.workspace },
      }),
    );
    return { sessionId, taskId, traceId };
  }
}
