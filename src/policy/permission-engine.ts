import {
  systemClock,
  toolRiskSchema,
  toolSideEffectSchema,
  utcTimestampSchema,
  type Clock,
  type StableId,
  type ToolRisk,
  type ToolSideEffect,
  type UtcTimestamp,
} from "../shared/contracts.js";
import { createOperationHash } from "./operation-hash.js";
import {
  approvalRecordSchema,
  approvalTokenSchema,
  operationBindingSchema,
  taskAuthorizationSchema,
  type ApprovalRecord,
  type ApprovalToken,
  type OperationBinding,
  type TaskAuthorization,
} from "./permission-contracts.js";

export type { ApprovalToken } from "./permission-contracts.js";

export interface PermissionSubject {
  readonly name: string;
  readonly risk: ToolRisk;
  readonly sideEffect: ToolSideEffect;
}

export interface PermissionContext {
  readonly binding: OperationBinding | null;
  readonly taskAuthorization: TaskAuthorization | null;
  readonly approvalToken: ApprovalToken | null;
  readonly approvalRecord: ApprovalRecord | null;
}

export type PermissionReasonCode =
  | "fixed_policy"
  | "task_authorization_required"
  | "task_authorization_invalid"
  | "task_authorization_expired"
  | "approval_required"
  | "approval_expired"
  | "approval_invalid"
  | "approval_denied"
  | "approval_consumed"
  | "approval_invalidated"
  | "approval_valid"
  | "policy_metadata_invalid";

export type PermissionDecision =
  | PermissionDecisionValue<"allow">
  | PermissionDecisionValue<"confirm">
  | PermissionDecisionValue<"deny">;

interface PermissionDecisionValue<TOutcome extends "allow" | "confirm" | "deny"> {
  readonly outcome: TOutcome;
  readonly reasonCode: PermissionReasonCode;
  readonly reason: string;
  readonly authorizationId: StableId | null;
  readonly approvalId: StableId | null;
}

/** Pre-C03 adapter retained only until C08 supplies full operation bindings. */
export interface LegacyApprovalToken {
  readonly approvalId: string;
  readonly toolName: string;
  readonly operationHash: string;
  readonly expiresAt: string;
}

/** Pre-C03 adapter retained only until C08 supplies durable approval records. */
export interface LegacyPermissionContext {
  readonly taskWriteAuthorized: boolean;
  readonly operationHash: string | null;
  readonly approvalToken: LegacyApprovalToken | null;
}

export class PermissionEngine {
  constructor(private readonly clock: Clock = systemClock) {}

  evaluate(tool: PermissionSubject, context: PermissionContext): PermissionDecision {
    if (!validToolPolicy(tool)) {
      return deny("policy_metadata_invalid", "The tool policy metadata is not registered.");
    }

    switch (tool.risk) {
      case "automatic":
      case "control":
        return allow("fixed_policy", "The registered risk class permits this control operation.");
      case "task_authorized":
        return this.#checkTaskAuthorization(tool.name, context);
      case "single_confirmation":
        return this.#checkApproval(tool.name, context);
    }
  }

  /**
   * Compatibility entry point for the current C08 runtime. New code must call
   * evaluate() with a complete OperationBinding and durable approval record.
   */
  decide(tool: PermissionSubject, context: LegacyPermissionContext): PermissionDecision {
    if (!validToolPolicy(tool)) {
      return deny("policy_metadata_invalid", "The tool risk class is not registered.");
    }
    if (tool.risk === "automatic" || tool.risk === "control") {
      return allow("fixed_policy", "Tool is permitted by its fixed risk class.");
    }
    if (tool.risk === "task_authorized") {
      return context.taskWriteAuthorized
        ? allow("fixed_policy", "The current task includes workspace write authorization.")
        : confirm("task_authorization_required", "Workspace write authorization is required.");
    }

    const token = context.approvalToken;
    if (!token || !context.operationHash) {
      return confirm("approval_required", "This operation needs a single-use confirmation.");
    }
    if (!token.approvalId.trim() || !utcTimestampSchema.safeParse(token.expiresAt).success) {
      return deny("approval_invalid", "The approval token is invalid.");
    }
    if (token.toolName !== tool.name || token.operationHash !== context.operationHash) {
      return deny("approval_invalid", "The approval is bound to different operation parameters.");
    }
    if (isExpired(token.expiresAt as UtcTimestamp, this.clock.utcNow())) {
      return confirm("approval_expired", "The approval has expired.");
    }
    return allow("approval_valid", "A matching, unexpired approval is present.");
  }

  #checkTaskAuthorization(toolName: string, context: PermissionContext): PermissionDecision {
    if (context.binding === null || context.taskAuthorization === null) {
      return confirm("task_authorization_required", "Workspace write authorization is required.");
    }
    const binding = operationBindingSchema.safeParse(context.binding);
    const authorization = taskAuthorizationSchema.safeParse(context.taskAuthorization);
    if (!binding.success || !authorization.success) {
      return deny("task_authorization_invalid", "The task authorization evidence is invalid.");
    }
    const evidence = authorization.data;
    const operation = binding.data;
    if (
      evidence.state !== "active" ||
      operation.toolName !== toolName ||
      evidence.sessionId !== operation.sessionId ||
      evidence.taskId !== operation.taskId ||
      evidence.workspaceId !== operation.workspaceId ||
      evidence.authorizationVersion !== operation.authorizationVersion
    ) {
      return deny(
        "task_authorization_invalid",
        "The task authorization is bound to different Session, Task, workspace, or policy version.",
      );
    }
    if (evidence.expiresAt !== null && isExpired(evidence.expiresAt, this.clock.utcNow())) {
      return confirm("task_authorization_expired", "The task authorization has expired.");
    }
    return allow(
      "fixed_policy",
      "The task authorization matches this workspace operation.",
      { authorizationId: evidence.authorizationId },
    );
  }

  #checkApproval(toolName: string, context: PermissionContext): PermissionDecision {
    if (context.binding === null || context.approvalToken === null || context.approvalRecord === null) {
      return confirm("approval_required", "This operation needs a single-use confirmation.");
    }
    const binding = operationBindingSchema.safeParse(context.binding);
    const token = approvalTokenSchema.safeParse(context.approvalToken);
    const record = approvalRecordSchema.safeParse(context.approvalRecord);
    if (!binding.success || !token.success || !record.success) {
      return deny("approval_invalid", "The approval evidence is invalid.");
    }
    let operationHash: string;
    try {
      operationHash = createOperationHash(binding.data);
    } catch {
      return deny("approval_invalid", "The operation binding is invalid.");
    }
    if (
      token.data.approvalId !== record.data.approvalId ||
      binding.data.toolName !== toolName ||
      token.data.operationHash !== operationHash ||
      token.data.operationHash !== record.data.operationHash ||
      token.data.expiresAt !== record.data.expiresAt ||
      createOperationHash(record.data.binding) !== operationHash ||
      record.data.summary.toolName !== binding.data.toolName ||
      record.data.summary.toolVersion !== binding.data.toolVersion ||
      record.data.summary.codeVersion !== binding.data.codeVersion ||
      record.data.summary.diffHash !== binding.data.diffHash ||
      record.data.summary.expiresAt !== record.data.expiresAt
    ) {
      return deny("approval_invalid", "The approval is bound to different operation parameters.");
    }
    if (isExpired(token.data.expiresAt, this.clock.utcNow())) {
      return confirm(
        "approval_expired",
        "The approval has expired.",
        { approvalId: record.data.approvalId },
      );
    }
    switch (record.data.state) {
      case "approved":
        return allow(
          "approval_valid",
          "A matching, approved, unexpired operation is present.",
          { approvalId: record.data.approvalId },
        );
      case "issued":
        return confirm(
          "approval_required",
          "This operation is still awaiting a decision.",
          { approvalId: record.data.approvalId },
        );
      case "expired":
        return confirm(
          "approval_expired",
          "The approval has expired.",
          { approvalId: record.data.approvalId },
        );
      case "denied":
        return deny(
          "approval_denied",
          "The user denied this exact operation.",
          { approvalId: record.data.approvalId },
        );
      case "consumed":
        return deny(
          "approval_consumed",
          "The single-use approval has already been consumed.",
          { approvalId: record.data.approvalId },
        );
      case "invalidated":
        return deny(
          "approval_invalidated",
          "The approval was invalidated before execution.",
          { approvalId: record.data.approvalId },
        );
    }
  }
}

function isExpired(expiresAt: UtcTimestamp, now: UtcTimestamp): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}

function validToolPolicy(tool: PermissionSubject): boolean {
  if (
    !toolRiskSchema.safeParse(tool.risk).success ||
    !toolSideEffectSchema.safeParse(tool.sideEffect).success ||
    !tool.name.trim()
  ) {
    return false;
  }
  switch (tool.risk) {
    case "automatic":
    case "control":
      return tool.sideEffect === "none";
    case "task_authorized":
      return tool.sideEffect === "workspace_write";
    case "single_confirmation":
      return tool.sideEffect !== "none";
  }
}

interface DecisionReferences {
  readonly authorizationId?: StableId;
  readonly approvalId?: StableId;
}

function allow(
  reasonCode: PermissionReasonCode,
  reason: string,
  references: DecisionReferences = {},
): PermissionDecision {
  return decision("allow", reasonCode, reason, references);
}

function confirm(
  reasonCode: PermissionReasonCode,
  reason: string,
  references: DecisionReferences = {},
): PermissionDecision {
  return decision("confirm", reasonCode, reason, references);
}

function deny(
  reasonCode: PermissionReasonCode,
  reason: string,
  references: DecisionReferences = {},
): PermissionDecision {
  return decision("deny", reasonCode, reason, references);
}

function decision<TOutcome extends "allow" | "confirm" | "deny">(
  outcome: TOutcome,
  reasonCode: PermissionReasonCode,
  reason: string,
  references: DecisionReferences,
): PermissionDecisionValue<TOutcome> {
  return {
    outcome,
    reasonCode,
    reason,
    authorizationId: references.authorizationId ?? null,
    approvalId: references.approvalId ?? null,
  };
}
