import type { AgentEvent } from "../events/agent-event.js";
import { validateJsonValue } from "../shared/json.js";
import { redactSensitiveValues } from "../shared/redaction.js";

export function exportSanitizedTrace(events: readonly AgentEvent[]): string {
  const validated = validateJsonValue(events);
  if (!validated.ok) {
    throw new TypeError(
      `Agent trace is not JSON serializable: ${validated.error.message} at ${validated.error.path}`,
    );
  }
  return `${JSON.stringify(redactSensitiveValues(validated.value), null, 2)}\n`;
}
