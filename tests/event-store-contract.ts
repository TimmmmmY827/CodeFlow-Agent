import type { AgentEvent } from "../src/events/agent-event.js";
import type {
  EventAppendResult,
  EventListener,
  EventStore,
} from "../src/events/event-store.js";
import type { StableId } from "../src/shared/contracts.js";

export interface EventStoreContractHarness {
  readonly store: EventStore & {
    subscribe(sessionId: StableId, listener: EventListener): () => void;
  };
  append(event: AgentEvent): Promise<EventAppendResult>;
  initialAppendNotifies: boolean;
  createEvent(
    sequence: number,
    type: "session.created" | "session.started",
    overrides?: Partial<AgentEvent>,
  ): AgentEvent;
  close(): void;
}

export type EventStoreContractFactory = () => EventStoreContractHarness;
