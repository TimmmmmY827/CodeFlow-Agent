import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { InMemoryEventStore } from "../src/events/event-store.js";

describe("InMemoryEventStore", () => {
  it("appends facts once, reports duplicates, and supports replay pagination", async () => {
    const store = new InMemoryEventStore();
    const sessionId = randomUUID();
    const taskId = randomUUID();
    const first = event(sessionId, taskId, 0, "session.created");
    const second = event(sessionId, taskId, 1, "session.started");
    const observed: string[] = [];
    const unsubscribe = store.subscribe(sessionId, (fact) => {
      observed.push(fact.type);
    });

    await expect(store.append(first)).resolves.toBe("inserted");
    await expect(store.append(first)).resolves.toBe("duplicate");
    await expect(store.append(second)).resolves.toBe("inserted");
    unsubscribe();

    await expect(store.list(sessionId)).resolves.toHaveLength(2);
    await expect(store.list(sessionId, 0)).resolves.toEqual([second]);
    await expect(store.latestSequence(sessionId)).resolves.toBe(1);
    expect(observed).toEqual(["session.created", "session.started"]);
  });

  it("rejects event ID conflicts and non-increasing sequences", async () => {
    const store = new InMemoryEventStore();
    const sessionId = randomUUID();
    const taskId = randomUUID();
    const first = event(sessionId, taskId, 0, "session.created");

    await store.append(first);
    const conflictingId = { ...first, payload: { goal: "different" } };
    await expect(store.append(conflictingId)).rejects.toMatchObject({
      name: "EventStoreError",
      details: { category: "event_id_conflict" },
    });

    const conflictingSequence = event(sessionId, taskId, 0, "session.started");
    await expect(store.append(conflictingSequence)).rejects.toMatchObject({
      details: { category: "event_sequence_conflict" },
    });
  });

  it("keeps a gap visible for trace integrity instead of silently repairing it", async () => {
    const store = new InMemoryEventStore();
    const sessionId = randomUUID();
    const taskId = randomUUID();

    await store.append(event(sessionId, taskId, 0, "session.created"));
    await store.append(event(sessionId, taskId, 2, "session.started"));

    await expect(store.latestSequence(sessionId)).resolves.toBe(2);
    await expect(store.list(sessionId)).resolves.toHaveLength(2);
  });
});

function event(
  sessionId: string,
  taskId: string,
  sequence: number,
  type: "session.created" | "session.started",
) {
  return createAgentEvent({
    sessionId,
    taskId,
    sequence,
    type,
    context: createEventContext({ workspacePath: "." }),
    payload: type === "session.created" ? { goal: "test" } : {},
  });
}
