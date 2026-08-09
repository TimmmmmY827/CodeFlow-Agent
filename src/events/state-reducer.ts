import type { AgentEvent } from "./agent-event.js";

export type SessionLifecycle =
  | "CREATED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "VERIFYING"
  | "COMPLETION_VERIFIED"
  | "CANCELLING"
  | "CANCELLED"
  | "FAILED"
  | "UNKNOWN";

export interface SessionView {
  readonly sessionId: string;
  readonly status: SessionLifecycle;
  readonly goal: string | null;
  readonly plan: readonly string[];
  readonly activeOperation: string | null;
  readonly lastError: string | null;
  readonly verificationPassed: boolean | null;
  readonly lastSequence: number;
}

export function reduceAgentEvents(events: readonly AgentEvent[]): SessionView | null {
  const first = events[0];
  if (!first) {
    return null;
  }

  let view: SessionView = {
    sessionId: first.sessionId,
    status: "CREATED",
    goal: readString(first.payload, "goal"),
    plan: [],
    activeOperation: null,
    lastError: null,
    verificationPassed: null,
    lastSequence: first.sequence,
  };

  for (const event of events) {
    if (event.sessionId !== view.sessionId) {
      throw new Error("Cannot reduce events from multiple sessions");
    }

    view = applyEvent(view, event);
  }

  return view;
}

function applyEvent(view: SessionView, event: AgentEvent): SessionView {
  const base = { ...view, lastSequence: event.sequence };

  switch (event.type) {
    case "session.created":
      return { ...base, status: "CREATED", goal: readString(event.payload, "goal") };
    case "session.started":
      return { ...base, status: "RUNNING" };
    case "plan.updated":
      return { ...base, plan: readStringArray(event.payload, "steps") };
    case "model.started":
      return { ...base, status: "RUNNING", activeOperation: "model" };
    case "model.completed":
      return { ...base, activeOperation: null };
    case "tool.started":
      return {
        ...base,
        status: "RUNNING",
        activeOperation: readString(event.payload, "tool") ?? "tool",
      };
    case "tool.completed":
      return { ...base, activeOperation: null };
    case "tool.failed":
      return {
        ...base,
        activeOperation: null,
        lastError: readString(event.payload, "message") ?? "Tool failed",
      };
    case "approval.requested":
      return { ...base, status: "WAITING_APPROVAL" };
    case "approval.resolved":
      return { ...base, status: "RUNNING" };
    case "verification.started":
      return { ...base, status: "VERIFYING", verificationPassed: null };
    case "verification.completed":
      return {
        ...base,
        status: readBoolean(event.payload, "passed") ? "RUNNING" : "FAILED",
        verificationPassed: readBoolean(event.payload, "passed"),
      };
    case "session.cancelling":
      return { ...base, status: "CANCELLING" };
    case "session.cancelled":
      return { ...base, status: "CANCELLED", activeOperation: null };
    case "session.failed":
      return {
        ...base,
        status: "FAILED",
        activeOperation: null,
        lastError: readString(event.payload, "message") ?? "Session failed",
      };
    case "session.completed":
      return { ...base, status: "COMPLETION_VERIFIED", activeOperation: null };
  }
}

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function readBoolean(payload: Readonly<Record<string, unknown>>, key: string): boolean {
  return payload[key] === true;
}

function readStringArray(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = payload[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
