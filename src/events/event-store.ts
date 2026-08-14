import { stableIdSchema, type StructuredError, type StableId } from "../shared/contracts.js";
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
    const checkedSessionId = validateEventSessionId(sessionId);
    validateEventCursor(afterSequence);
    const events = this.#events.get(checkedSessionId) ?? [];
    return events
      .filter((event) => afterSequence === undefined || event.sequence > afterSequence)
      .map((event) => cloneEvent(event));
  }

  async latestSequence(sessionId: StableId): Promise<number | null> {
    const checkedSessionId = validateEventSessionId(sessionId);
    return this.#events.get(checkedSessionId)?.at(-1)?.sequence ?? null;
  }

  subscribe(sessionId: StableId, listener: EventListener): () => void {
    const checkedSessionId = validateEventSessionId(sessionId);
    validateEventListener(listener);
    const listeners = this.#listeners.get(checkedSessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(checkedSessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(checkedSessionId);
    };
  }

  async #notify(sessionId: StableId, event: AgentEvent): Promise<void> {
    const listeners = [...(this.#listeners.get(sessionId) ?? [])];
    await Promise.allSettled(
      listeners.map(async (listener) => listener(cloneEvent(event))),
    );
  }
}

export function validateEventSessionId(sessionId: StableId): StableId {
  const parsed = stableIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new EventStoreError(
      inputError(
        "invalid_session_id",
        "sessionId must be a UUID stable ID.",
        "Use the persisted Session ID when reading or subscribing to events.",
      ),
    );
  }
  return parsed.data;
}

export function validateEventCursor(afterSequence: number | undefined): void {
  if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < -1)) {
    throw new EventStoreError(
      inputError(
        "event_cursor_invalid",
        "afterSequence must be a safe integer greater than or equal to -1.",
        "Restart incremental reading with a valid persisted sequence.",
      ),
    );
  }
}

export function validateEventListener(listener: EventListener): void {
  if (typeof listener !== "function") {
    throw new EventStoreError(
      inputError(
        "invalid_event_listener",
        "Event listener must be a function.",
        "Pass a callable listener before subscribing.",
      ),
    );
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

function inputError(category: string, message: string, recovery: string): StructuredError {
  return {
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  };
}
