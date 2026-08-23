import { createHash } from "node:crypto";

import { canonicalJson } from "../shared/json.js";
import {
  operationBindingSchema,
  type OperationBinding,
} from "./permission-contracts.js";

export function createOperationHash(binding: OperationBinding): string {
  const parsed = operationBindingSchema.parse(binding);
  return digestCanonical(parsed);
}

/** Hashes the final Zod-parsed and version-normalized tool input. */
export function createEffectiveInputHash(effectiveInput: unknown): string {
  return digestCanonical(effectiveInput);
}

function digestCanonical(value: unknown): string {
  const canonical = canonicalJson(value);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
