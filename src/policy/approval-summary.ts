import {
  approvalSummarySchema,
  PERMISSION_SCHEMA_VERSION,
  type ApprovalResource,
  type ApprovalSummary,
  type OperationBinding,
} from "./permission-contracts.js";
import type { UtcTimestamp } from "../shared/contracts.js";

export function createApprovalSummary(input: {
  readonly binding: OperationBinding;
  readonly resources: readonly ApprovalResource[];
  readonly expiresAt: UtcTimestamp;
}): ApprovalSummary {
  return approvalSummarySchema.parse({
    schemaVersion: PERMISSION_SCHEMA_VERSION,
    toolName: input.binding.toolName,
    toolVersion: input.binding.toolVersion,
    resources: input.resources,
    codeVersion: input.binding.codeVersion,
    diffHash: input.binding.diffHash,
    expiresAt: input.expiresAt,
  });
}

