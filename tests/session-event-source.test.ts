import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ReplayTailSessionEventSource } from "../src/app/session-event-source.js";
import { createAgentEvent, createEventContext, type AgentEvent } from "../src/events/agent-event.js";
import { InMemoryEventStore } from "../src/events/event-store.js";
import type { StableId } from "../src/shared/contracts.js";
import type { JsonObject } from "../src/shared/json.js";

describe("C12 replay-then-tail Session event source", () => {
  it("does not lose events appended between subscription and history completion", async () => {
    const identity = identifiers();
    const created = fact(identity, 0, "session.created", { goal: "Inspect" });
    const started = fact(identity, 1, "session.started");
    const failed = fact(identity, 2, "session.failed", {}, failure());
    const store = new BoundaryStore(async () => {
      await store.append(started);
      await store.append(failed);
    });
    await store.append(created);
    const source = new ReplayTailSessionEventSource(identity.sessionId, store);

    const received: AgentEvent[] = [];
    for await (const event of source.streamEvents({ afterSequence: -1, signal: new AbortController().signal })) {
      received.push(event);
    }

    expect(received.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(received.map((event) => event.eventId)).toEqual([created.eventId, started.eventId, failed.eventId]);
  });

  it("disconnects a slow consumer instead of blocking event append", async () => {
    const identity = identifiers();
    const store = new InMemoryEventStore();
    await store.append(fact(identity, 0, "session.created", { goal: "Inspect" }));
    const source = new ReplayTailSessionEventSource(identity.sessionId, store, { maxBufferedEvents: 1 });
    const iterator = source.streamEvents({ afterSequence: -1, signal: new AbortController().signal })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { sequence: 0 } });
    await store.append(fact(identity, 1, "session.started"));
    await store.append(fact(identity, 2, "session.failed", {}, failure()));

    await expect(iterator.next()).rejects.toMatchObject({
      details: { category: "session_event_stream_overflow", retryable: false },
    });
  });

  it("does not apply the live slow-consumer cap to an existing durable replay", async () => {
    const identity = identifiers();
    const store = new InMemoryEventStore();
    await store.append(fact(identity, 0, "session.created", { goal: "Inspect" }));
    for (let sequence = 1; sequence < 300; sequence += 1) {
      await store.append(fact(identity, sequence, "budget.updated"));
    }
    await store.append(fact(identity, 300, "session.failed", {}, failure()));
    const source = new ReplayTailSessionEventSource(identity.sessionId, store, { maxBufferedEvents: 1 });
    const received: number[] = [];

    for await (const event of source.streamEvents({ afterSequence: -1, signal: new AbortController().signal })) {
      received.push(event.sequence);
    }

    expect(received).toHaveLength(301);
    expect(received.at(-1)).toBe(300);
  });

  it("unblocks cleanly when the caller cancels an idle tail", async () => {
    const identity = identifiers();
    const controller = new AbortController();
    const source = new ReplayTailSessionEventSource(identity.sessionId, new InMemoryEventStore());
    const iterator = source.streamEvents({ afterSequence: -1, signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });
});

class BoundaryStore extends InMemoryEventStore {
  #beforeFirstList: (() => Promise<void>) | null;

  constructor(beforeFirstList: () => Promise<void>) {
    super();
    this.#beforeFirstList = beforeFirstList;
  }

  override async list(sessionId: StableId, afterSequence?: number): Promise<readonly AgentEvent[]> {
    const snapshot = await super.list(sessionId, afterSequence);
    const hook = this.#beforeFirstList;
    this.#beforeFirstList = null;
    if (hook) await hook();
    return snapshot;
  }
}

function identifiers() {
  return { sessionId: randomUUID(), taskId: randomUUID(), traceId: randomUUID() } as const;
}

function fact(
  identity: ReturnType<typeof identifiers>,
  sequence: number,
  type: AgentEvent["type"],
  payload: JsonObject = {},
  error: AgentEvent["context"]["error"] = null,
): AgentEvent {
  return createAgentEvent({
    ...identity,
    sequence,
    type,
    context: createEventContext({ workspacePath: "C:/workspace", error }),
    payload,
    occurredAt: "2026-08-15T00:00:00.000Z",
  });
}

function failure() {
  return {
    category: "test_failure",
    message: "Injected failure.",
    retryable: false,
    sideEffectStatus: "none" as const,
    recovery: null,
  };
}
