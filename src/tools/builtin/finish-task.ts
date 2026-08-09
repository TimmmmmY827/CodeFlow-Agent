import type { CompletionDecision, CompletionSnapshot } from "../../completion/completion-gate.js";
import { CompletionGate, completionClaimSchema } from "../../completion/completion-gate.js";
import type { ToolDefinition } from "../tool.js";

export interface CompletionSnapshotProvider {
  capture(workspace: string): Promise<CompletionSnapshot>;
}

export function createFinishTaskTool(
  snapshotProvider: CompletionSnapshotProvider,
  completionGate = new CompletionGate(),
): ToolDefinition<unknown, CompletionDecision> {
  return {
    name: "finish_task",
    description:
      "Claim task completion with the bound code version, diff hash, verification evidence, unverified items, trace status, and safety vetoes.",
    risk: "control",
    sideEffect: "none",
    retryPolicy: "safe",
    inputSchema: completionClaimSchema,
    execute: async (claim, context) => {
      const snapshot = await snapshotProvider.capture(context.workspace);
      return completionGate.evaluate(claim, snapshot);
    },
  };
}
