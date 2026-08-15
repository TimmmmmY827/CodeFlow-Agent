import type { AgentEvent } from "../events/agent-event.js";
import type { EventReader, EventSubscriber } from "../events/event-store.js";
import type { SessionEventSource, SessionEventStreamOptions } from "../cli/ui/session-task-tree.js";
import type { StableId, StructuredError } from "../shared/contracts.js";
import { canonicalJson } from "../shared/json.js";

const DEFAULT_MAX_BUFFERED_EVENTS = 256;
const TERMINAL_EVENTS = new Set<AgentEvent["type"]>([
  "completion.verified",
  "session.cancelled",
  "session.failed",
]);

export interface ReplayTailSessionEventSourceOptions {
  readonly maxBufferedEvents?: number;
}

export class SessionEventStreamError extends Error {
  readonly details: StructuredError;

  constructor(details: StructuredError) {
    super(details.message);
    this.name = "SessionEventStreamError";
    this.details = details;
  }
}

/** C12 replay-then-tail bridge. Subscription is established before history is read. */
export class ReplayTailSessionEventSource implements SessionEventSource {
  readonly #maxBufferedEvents: number;

  constructor(
    readonly sessionId: StableId,
    private readonly events: EventReader & EventSubscriber,
    options: ReplayTailSessionEventSourceOptions = {},
  ) {
    const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    if (!Number.isSafeInteger(maxBufferedEvents) || maxBufferedEvents <= 0) {
      throw new RangeError("maxBufferedEvents must be a positive safe integer.");
    }
    this.#maxBufferedEvents = maxBufferedEvents;
  }

  streamEvents(options: SessionEventStreamOptions): AsyncIterable<AgentEvent> {
    return this.#stream(options);
  }

  async *#stream(options: SessionEventStreamOptions): AsyncGenerator<AgentEvent> {
    let cursor = options.afterSequence;
    const pending = new Map<number, AgentEvent>();
    const liveSequences = new Set<number>();
    let streamFailure: SessionEventStreamError | null = null;
    let wake: (() => void) | null = null;
    const signalWake = (): void => wake?.();
    const enqueue = (event: AgentEvent, live: boolean): void => {
      if (event.sequence <= cursor) return;
      const existing = pending.get(event.sequence);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(event)) {
          streamFailure = streamError(
            "event_sequence_conflict",
            `Sequence ${event.sequence} was delivered with conflicting facts.`,
            "Stop the Session and inspect durable storage before reconnecting.",
          );
        }
        wake?.();
        return;
      }
      if (live && liveSequences.size >= this.#maxBufferedEvents) {
        streamFailure = streamError(
          "session_event_stream_overflow",
          `The Session event stream exceeded ${this.#maxBufferedEvents} buffered facts.`,
          `Reconnect from sequence ${cursor} after the consumer is ready.`,
        );
        wake?.();
        return;
      }
      pending.set(event.sequence, event);
      if (live) liveSequences.add(event.sequence);
      wake?.();
    };

    options.signal.addEventListener("abort", signalWake, { once: true });
    const unsubscribe = this.events.subscribe(this.sessionId, (event) => enqueue(event, true));
    try {
      for (const event of await this.events.list(this.sessionId, cursor)) enqueue(event, false);
      for (;;) {
        if (options.signal.aborted) return;
        if (streamFailure) throw streamFailure;
        const nextSequence = [...pending.keys()].sort((left, right) => left - right)[0];
        if (nextSequence !== undefined) {
          const event = pending.get(nextSequence);
          pending.delete(nextSequence);
          liveSequences.delete(nextSequence);
          if (!event || event.sequence <= cursor) continue;
          cursor = event.sequence;
          yield structuredClone(event);
          if (TERMINAL_EVENTS.has(event.type)) return;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (options.signal.aborted || streamFailure || pending.size > 0) resolve();
        });
        wake = null;
      }
    } finally {
      options.signal.removeEventListener("abort", signalWake);
      unsubscribe();
    }
  }
}

function streamError(category: string, message: string, recovery: string): SessionEventStreamError {
  return new SessionEventStreamError({
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  });
}
