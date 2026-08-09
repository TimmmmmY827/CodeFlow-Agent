import type { ToolRisk } from "../tools/tool.js";

export interface PermissionSubject {
  readonly name: string;
  readonly risk: ToolRisk;
}

export interface ApprovalToken {
  readonly approvalId: string;
  readonly toolName: string;
  readonly operationHash: string;
  readonly expiresAt: string;
}

export interface PermissionContext {
  readonly taskWriteAuthorized: boolean;
  readonly operationHash: string | null;
  readonly approvalToken: ApprovalToken | null;
}

export type PermissionDecision =
  | { readonly outcome: "allow"; readonly reason: string }
  | { readonly outcome: "confirm"; readonly reason: string }
  | { readonly outcome: "deny"; readonly reason: string };

export class PermissionEngine {
  decide(tool: PermissionSubject, context: PermissionContext): PermissionDecision {
    switch (tool.risk) {
      case "automatic":
      case "control":
        return { outcome: "allow", reason: "Tool is permitted by its fixed risk class." };
      case "task_authorized":
        return context.taskWriteAuthorized
          ? { outcome: "allow", reason: "The current task includes workspace write authorization." }
          : { outcome: "confirm", reason: "Workspace write authorization is required." };
      case "single_confirmation":
        return this.#checkApproval(tool.name, context);
    }
  }

  #checkApproval(toolName: string, context: PermissionContext): PermissionDecision {
    const token = context.approvalToken;
    if (!token || !context.operationHash) {
      return { outcome: "confirm", reason: "This operation needs a single-use confirmation." };
    }
    if (!token.approvalId.trim()) {
      return { outcome: "deny", reason: "The approval identifier is invalid." };
    }
    if (token.toolName !== toolName || token.operationHash !== context.operationHash) {
      return { outcome: "deny", reason: "The approval is bound to different operation parameters." };
    }
    const expiresAt = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return { outcome: "deny", reason: "The approval expiration is invalid." };
    }
    if (expiresAt <= Date.now()) {
      return { outcome: "confirm", reason: "The approval has expired." };
    }
    return { outcome: "allow", reason: "A matching, unexpired approval is present." };
  }
}
