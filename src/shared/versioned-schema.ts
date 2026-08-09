import type { ZodType } from "zod";

import { err, ok, type Result } from "./result.js";
import { schemaVersionSchema, type StructuredError } from "./contracts.js";
import { validateJsonValue } from "./json.js";

export function parseVersionedSchema<T>(
  schemaName: string,
  supportedMajor: number,
  schema: ZodType<T>,
  input: unknown,
): Result<T, StructuredError> {
  const json = validateJsonValue(input);
  if (!json.ok) return err(json.error);

  const schemaVersion = readSchemaVersion(input);
  if (schemaVersion === null) {
    return err(schemaError(
      "invalid_schema",
      `${schemaName} must include a positive integer schemaVersion.`,
      null,
    ));
  }
  if (schemaVersion !== supportedMajor) {
    return err(schemaError(
      "unsupported_schema_version",
      `${schemaName} schema major version ${schemaVersion} is not supported; expected ${supportedMajor}.`,
      `Migrate ${schemaName} to schema major version ${supportedMajor} before retrying.`,
    ));
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err(schemaError(
      "invalid_schema",
      `${schemaName} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      null,
    ));
  }
  return ok(parsed.data);
}

function readSchemaVersion(input: unknown): number | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const result = schemaVersionSchema.safeParse(
    (input as Readonly<Record<string, unknown>>).schemaVersion,
  );
  return result.success ? result.data : null;
}

function schemaError(
  category: "invalid_schema" | "unsupported_schema_version",
  message: string,
  recovery: string | null,
): StructuredError {
  return {
    category,
    message,
    retryable: false,
    sideEffectStatus: "none",
    recovery,
  };
}
