import type { AgentEvent } from "../events/agent-event.js";

const SENSITIVE_KEY = /(api[-_]?key|token|password|secret|authorization|reasoning)/i;

export function exportSanitizedTrace(events: readonly AgentEvent[]): string {
  return `${JSON.stringify(events.map(redactEvent), null, 2)}\n`;
}

function redactEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    payload: redactRecord(event.payload),
  };
}

function redactRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return redactRecord(value as Readonly<Record<string, unknown>>);
  }
  return value;
}
