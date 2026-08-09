import { createAgentEvent, createEventContext } from "../events/agent-event.js";
import type { EventStore } from "../events/event-store.js";
import { createStableId, type StableId } from "../shared/contracts.js";

export interface CreateSessionRequest {
  readonly goal: string;
  readonly workspace: string;
}

export interface CreatedSession {
  readonly sessionId: StableId;
  readonly taskId: StableId;
  readonly traceId: StableId;
}

export class AgentEventLoop {
  constructor(private readonly eventStore: EventStore) {}

  async createSession(request: CreateSessionRequest): Promise<CreatedSession> {
    const sessionId = createStableId();
    const taskId = createStableId();
    const traceId = createStableId();
    await this.eventStore.append(
      createAgentEvent({
        sessionId,
        taskId,
        traceId,
        sequence: 0,
        type: "session.created",
        context: createEventContext({ workspacePath: request.workspace }),
        payload: { goal: request.goal, workspace: request.workspace },
      }),
    );
    return { sessionId, taskId, traceId };
  }
}
