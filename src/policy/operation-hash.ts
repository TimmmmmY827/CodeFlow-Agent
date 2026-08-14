import { createHash } from "node:crypto";

import { canonicalJson } from "../shared/json.js";

export interface OperationIdentity {
  readonly toolName: string;
  readonly input: unknown;
  readonly codeVersion: string | null;
}

export function createOperationHash(identity: OperationIdentity): string {
  const canonical = canonicalJson(identity);
  return createHash("sha256").update(canonical).digest("hex");
}
