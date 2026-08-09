import type { StructuredError, StableId } from "../shared/contracts.js";
import { canonicalJson } from "../shared/json.js";
import { parseAgentEvent, type AgentEvent } from "./agent-event.js";

export type EventAppendResult = "inserted" | "duplicate";
export type EventListener = (event: AgentEvent) => void | Promise<void>;

export interface EventWriter {
  append(event: AgentEvent): Promise<EventAppendResult>;
}

export interface EventReader {
  list(sessionId: StableId, afterSequence?: number): Promise<readonly AgentEvent[]>;
  latestSequence(sessionId: StableId): Promise<number | null>;
}

export interface EventSubscriber {
  subscribe(sessionId: StableId, listener: EventListener): () => void;
}

export interface EventStore extends EventWriter, EventReader {}

export class EventStoreError extends Error {
  readonly details: StructuredError;

  constructor(details: StructuredError) {
    super(details.message);
    this.name = "EventStoreError";
    this.details = details;
  }
}

export class InMemoryEventStore implements EventStore, EventSubscriber {
  readonly #events = new Map<StableId, AgentEvent[]>();
  readonly #eventsById = new Map<StableId, AgentEvent>();
  readonly #listeners = new Map<StableId, Set<EventListener>>();

  async append(event: AgentEvent): Promise<EventAppendResult> {
    const parsed = parseAgentEvent(event);
    if (!parsed.ok) throw new EventStoreError(parsed.error);

    const existingById = this.#eventsById.get(parsed.value.eventId);
    if (existingById) {
      if (canonicalJson(existingById) === canonicalJson(parsed.value)) return "duplicate";
      throw new EventStoreError(
        storeError(
          "event_id_conflict",
          `Event ID ${parsed.value.eventId} already exists with different contents.`,
          "Stop the session and inspect the conflicting trace before retrying.",
        ),
      );
    }

    const events = this.#events.get(parsed.value.sessionId) ?? [];
    const previous = events.at(-1);
    if (previous && parsed.value.sequence <= previous.sequence) {
      throw new EventStoreError(
        storeError(
          "event_sequence_conflict",
          `Event sequence ${parsed.value.sequence} is not greater than ${previous.sequence}.`,
          "Reload the session sequence and append a new fact with the next available sequence.",
        ),
      );
    }

    events.push(parsed.value);
    this.#events.set(parsed.value.sessionId, events);
    this.#eventsById.set(parsed.value.eventId, parsed.value);
    await this.#notify(parsed.value.sessionId, parsed.value);
    return "inserted";
  }

  async list(sessionId: StableId, afterSequence?: number): Promise<readonly AgentEvent[]> {
    const events = this.#events.get(sessionId) ?? [];
    return events
      .filter((event) => afterSequence === undefined || event.sequence > afterSequence)
      .map((event) => cloneEvent(event));
  }

  async latestSequence(sessionId: StableId): Promise<number | null> {
    return this.#events.get(sessionId)?.at(-1)?.sequence ?? null;
  }

  subscribe(sessionId: StableId, listener: EventListener): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
    };
  }

  async #notify(sessionId: StableId, event: AgentEvent): Promise<void> {
    const listeners = [...(this.#listeners.get(sessionId) ?? [])];
    await Promise.allSettled(listeners.map((listener) => listener(cloneEvent(event))));
  }
}

function cloneEvent(event: AgentEvent): AgentEvent {
  return structuredClone(event);
}

function storeError(
  category: "event_id_conflict" | "event_sequence_conflict",
  message: string,
  recovery: string,
): StructuredError {
  return {
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  };
}
