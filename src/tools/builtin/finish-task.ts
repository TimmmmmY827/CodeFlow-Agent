import type { CompletionDecision, CompletionSnapshot } from "../../completion/completion-gate.js";
import { CompletionGate, completionClaimSchema, completionDecisionSchema } from "../../completion/completion-gate.js";
import { systemClock } from "../../shared/contracts.js";
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
    version: "tool:finish_task@1.0.0",
    normalizationVersion: "normalization:finish-task-v1",
    description:
      "Claim task completion with the bound code version, diff hash, verification evidence, unverified items, trace status, and safety vetoes.",
    risk: "control",
    sideEffect: "none",
    retryPolicy: "safe",
    inputSchema: completionClaimSchema,
    outputSchema: completionDecisionSchema,
    availability: { available: true, reasonCode: null, message: null, checkedAt: systemClock.utcNow() },
    normalizeInput: (input) => ({ effectiveInput: input, transformations: [] }),
    claimResources: () => [{ key: "workspace:completion", mode: "read", scope: "workspace" }],
    execute: async (claim, context) => {
      const snapshot = await snapshotProvider.capture(context.workspace);
      return completionGate.evaluate(claim, snapshot);
    },
  };
}
