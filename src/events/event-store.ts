import type { AgentEvent } from "./agent-event.js";

export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  list(sessionId: string): Promise<readonly AgentEvent[]>;
}

export class InMemoryEventStore implements EventStore {
  readonly #events = new Map<string, AgentEvent[]>();

  async append(event: AgentEvent): Promise<void> {
    const events = this.#events.get(event.sessionId) ?? [];
    const previous = events.at(-1);

    if (previous && event.sequence <= previous.sequence) {
      throw new Error(
        `Event sequence must increase: received ${event.sequence} after ${previous.sequence}`,
      );
    }

    events.push(event);
    this.#events.set(event.sessionId, events);
  }

  async list(sessionId: string): Promise<readonly AgentEvent[]> {
    return [...(this.#events.get(sessionId) ?? [])];
  }
}
