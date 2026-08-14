import { createHash } from "node:crypto";

import { parseAgentEvent, type AgentEvent } from "../../events/agent-event.js";
import { canonicalJson } from "../../shared/json.js";
import { storageError } from "./sqlite-errors.js";

export interface EncodedAgentEvent {
  readonly json: string;
  readonly hash: string;
}

export interface StoredAgentEventRow {
  readonly event_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly sequence: unknown;
  readonly event_type: unknown;
  readonly schema_version: unknown;
  readonly occurred_at: unknown;
  readonly trace_id: unknown;
  readonly span_id: unknown;
  readonly parent_span_id: unknown;
  readonly event_hash: unknown;
  readonly event_json: unknown;
}

export function encodeAgentEvent(event: AgentEvent): EncodedAgentEvent {
  const json = canonicalJson(event);
  return { json, hash: hashCanonicalJson(json) };
}

export function decodeAgentEvent(row: StoredAgentEventRow): AgentEvent {
  const json = requireString(row.event_json, "event_json");
  const storedHash = requireString(row.event_hash, "event_hash");
  if (hashCanonicalJson(json) !== storedHash) {
    throw corruptEvent("A persisted AgentEvent hash does not match its canonical JSON.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw corruptEvent(
      `A persisted AgentEvent is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseAgentEvent(raw);
  if (!parsed.ok) {
    throw corruptEvent(`A persisted AgentEvent is invalid: ${parsed.error.message}`);
  }

  const event = parsed.value;
  if (canonicalJson(event) !== json) {
    throw corruptEvent("A persisted AgentEvent is not encoded as canonical JSON.");
  }
  const indexedValues: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [row.event_id, event.eventId, "event_id"],
    [row.session_id, event.sessionId, "session_id"],
    [row.task_id, event.taskId, "task_id"],
    [row.sequence, event.sequence, "sequence"],
    [row.event_type, event.type, "event_type"],
    [row.schema_version, event.schemaVersion, "schema_version"],
    [row.occurred_at, event.occurredAt, "occurred_at"],
    [row.trace_id, event.traceId, "trace_id"],
    [row.span_id, event.spanId, "span_id"],
    [row.parent_span_id, event.parentSpanId, "parent_span_id"],
  ];
  for (const [stored, expected, column] of indexedValues) {
    if (stored !== expected) {
      throw corruptEvent(`Persisted AgentEvent index column ${column} disagrees with event_json.`);
    }
  }
  return event;
}

export function hashCanonicalJson(json: string): string {
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw corruptEvent(`Persisted AgentEvent column ${column} is not a string.`);
  }
  return value;
}

function corruptEvent(message: string) {
  return storageError(
    "storage_corrupt",
    message,
    false,
    "Stop writes and restore or inspect the affected Session facts.",
  );
}
