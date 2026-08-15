import { createHash } from "node:crypto";

import { canonicalJson } from "../shared/json.js";
import {
  operationBindingSchema,
  type OperationBinding,
} from "./permission-contracts.js";

export interface LegacyOperationIdentity {
  readonly toolName: string;
  readonly input: unknown;
  readonly codeVersion: string | null;
}

export function createOperationHash(binding: OperationBinding): string {
  const parsed = operationBindingSchema.parse(binding);
  return digestCanonical(parsed);
}

/** Hashes the final Zod-parsed and version-normalized tool input. */
export function createEffectiveInputHash(effectiveInput: unknown): string {
  return digestCanonical(effectiveInput);
}

/**
 * Temporary C08 compatibility hash. It deliberately has a different name so
 * no new caller mistakes the incomplete pre-C03 identity for an approval
 * binding.
 */
export function createLegacyOperationHash(identity: LegacyOperationIdentity): string {
  return digestCanonical(identity);
}

function digestCanonical(value: unknown): string {
  const canonical = canonicalJson(value);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
