import type { JsonValue } from "./json.js";

const SENSITIVE_EXACT_KEYS = new Set([
  "apikey",
  "authorization",
  "key",
  "password",
  "reasoning",
  "secret",
  "token",
]);

const AUDIT_REFERENCE_KEYS = new Set(["approvalid", "authorizationid"]);

export function redactSensitiveValues(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shouldRedactValue(key, item) ? "[REDACTED]" : redactSensitiveValues(item),
      ]),
    );
  }
  return value;
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (AUDIT_REFERENCE_KEYS.has(normalized)) return false;
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return normalized.endsWith("apikey") || normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") || normalized.endsWith("reasoning");
}

function shouldRedactValue(key: string, value: JsonValue): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (
    normalized === "authorization" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    isAuditAuthorization(value as Readonly<Record<string, JsonValue>>)
  ) {
    return false;
  }
  return isSensitiveKey(key);
}

function isAuditAuthorization(value: Readonly<Record<string, JsonValue>>): boolean {
  const allowedKeys = new Set(["approvalId", "authorizationId", "risk"]);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
