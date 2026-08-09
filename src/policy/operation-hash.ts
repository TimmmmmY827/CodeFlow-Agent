import { createHash } from "node:crypto";

export interface OperationIdentity {
  readonly toolName: string;
  readonly input: unknown;
  readonly codeVersion: string | null;
}

export function createOperationHash(identity: OperationIdentity): string {
  const canonical = JSON.stringify(canonicalize(identity));
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return { $type: typeof value, $value: String(value) };
}
