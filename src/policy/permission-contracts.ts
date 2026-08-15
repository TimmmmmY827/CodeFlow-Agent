import { z } from "zod";

import {
  stableIdSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
  type StableId,
  type StructuredError,
  type UtcTimestamp,
} from "../shared/contracts.js";

export const PERMISSION_SCHEMA_VERSION = 1;
export const OPERATION_BINDING_VERSION = 1;

const sha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Expected a canonical SHA-256 digest.");
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);

export const operationBindingSchema = z
  .object({
    bindingVersion: z.literal(OPERATION_BINDING_VERSION),
    sessionId: stableIdSchema,
    taskId: stableIdSchema,
    authorizationVersion: versionIdentifierSchema,
    toolName: toolNameSchema,
    toolVersion: versionIdentifierSchema,
    inputSchemaHash: sha256Schema,
    normalizationVersion: versionIdentifierSchema,
    effectiveInputHash: sha256Schema,
    workspaceId: stableIdSchema,
    codeVersion: versionIdentifierSchema.nullable(),
    diffHash: sha256Schema.nullable(),
    configVersion: versionIdentifierSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.diffHash !== null && binding.codeVersion === null) {
      context.addIssue({
        code: "custom",
        path: ["codeVersion"],
        message: "A diff hash requires a controlled code version.",
      });
    }
  });
export type OperationBinding = z.infer<typeof operationBindingSchema>;

export const taskAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(PERMISSION_SCHEMA_VERSION),
    authorizationId: stableIdSchema,
    authorizationVersion: versionIdentifierSchema,
    sessionId: stableIdSchema,
    taskId: stableIdSchema,
    workspaceId: stableIdSchema,
    state: z.enum(["active", "revoked"]),
    grantedAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((authorization, context) => {
    if (
      authorization.expiresAt !== null &&
      Date.parse(authorization.expiresAt) <= Date.parse(authorization.grantedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Task authorization must expire after it is granted.",
      });
    }
  });
export type TaskAuthorization = z.infer<typeof taskAuthorizationSchema>;

export const approvalTokenSchema = z
  .object({
    approvalId: stableIdSchema,
    operationHash: sha256Schema,
    expiresAt: utcTimestampSchema,
  })
  .strict();
export type ApprovalToken = z.infer<typeof approvalTokenSchema>;

export const approvalResourceSchema = z
  .object({
    kind: z.enum(["remote", "path", "branch", "version"]),
    value: z.string().trim().min(1).max(4_096).refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Approval resource labels cannot contain control characters.",
    ),
  })
  .strict()
  .superRefine((resource, context) => {
    if (resource.kind === "remote" && !/^[A-Za-z0-9._-]+$/.test(resource.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Remote summaries must use a configured remote name, not a URL or credential.",
      });
    }
  });
export type ApprovalResource = z.infer<typeof approvalResourceSchema>;

export const approvalSummarySchema = z
  .object({
    schemaVersion: z.literal(PERMISSION_SCHEMA_VERSION),
    toolName: toolNameSchema,
    toolVersion: versionIdentifierSchema,
    resources: z.array(approvalResourceSchema).max(32),
    codeVersion: versionIdentifierSchema.nullable(),
    diffHash: sha256Schema.nullable(),
    expiresAt: utcTimestampSchema,
  })
  .strict();
export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;

export const approvalStateSchema = z.enum([
  "issued",
  "approved",
  "denied",
  "expired",
  "consumed",
  "invalidated",
]);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

export const approvalRecordSchema = z
  .object({
    schemaVersion: z.literal(PERMISSION_SCHEMA_VERSION),
    approvalId: stableIdSchema,
    binding: operationBindingSchema,
    operationHash: sha256Schema,
    summary: approvalSummarySchema,
    state: approvalStateSchema,
    issuedAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
    resolvedAt: utcTimestampSchema.nullable(),
    consumedAt: utcTimestampSchema.nullable(),
    decisionReason: z.string().trim().min(1).max(1_024).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.expiresAt) <= Date.parse(record.issuedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Approval expiration must be after issuance.",
      });
    }
    if (record.resolvedAt !== null && Date.parse(record.resolvedAt) < Date.parse(record.issuedAt)) {
      context.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Approval resolution cannot predate issuance.",
      });
    }
    if (
      record.consumedAt !== null &&
      record.resolvedAt !== null &&
      Date.parse(record.consumedAt) < Date.parse(record.resolvedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["consumedAt"],
        message: "Approval consumption cannot predate its decision.",
      });
    }
    const needsResolution = record.state !== "issued";
    if (needsResolution !== (record.resolvedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Only issued approvals may omit resolvedAt.",
      });
    }
    if ((record.state === "consumed") !== (record.consumedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["consumedAt"],
        message: "consumedAt is required only for consumed approvals.",
      });
    }
    if ((record.state !== "issued") !== (record.decisionReason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["decisionReason"],
        message: "Every resolved approval must retain a decision reason.",
      });
    }
  });
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export interface IssueApprovalInput {
  readonly approvalId: StableId;
  readonly binding: OperationBinding;
  readonly expiresAt: UtcTimestamp;
  readonly summary: ApprovalSummary;
}

export interface ResolveApprovalInput {
  readonly approvalId: StableId;
  readonly decision: "approved" | "denied";
  readonly reason: string | null;
}

export interface ConsumeApprovalInput {
  readonly approvalId: StableId;
  readonly operationHash: string;
}

export interface ApprovalRepository {
  issue(input: IssueApprovalInput): Promise<"inserted" | "duplicate">;
  get(approvalId: StableId): Promise<ApprovalRecord | null>;
  resolve(input: ResolveApprovalInput): Promise<ApprovalRecord>;
  consume(input: ConsumeApprovalInput): Promise<ApprovalRecord>;
  invalidate(approvalId: StableId, reason: string): Promise<ApprovalRecord>;
  expire(approvalId: StableId): Promise<ApprovalRecord>;
}

export class ApprovalError extends Error {
  readonly details: StructuredError;

  constructor(details: StructuredError) {
    super(details.message);
    this.name = "ApprovalError";
    this.details = details;
  }
}
