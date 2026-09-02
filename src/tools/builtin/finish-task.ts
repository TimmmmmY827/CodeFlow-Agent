import type { CompletionDecision, CompletionGateContextProvider } from "../../completion/completion-gate.js";
import { CompletionGate, completionDecisionSchema, completionIntentSchema } from "../../completion/completion-gate.js";
import { systemClock } from "../../shared/contracts.js";
import type { ToolDefinition } from "../tool.js";
import type { ToolRegistry } from "../tool-registry.js";

export function registerFinishTaskTool(
  registry: ToolRegistry,
  contextProvider: CompletionGateContextProvider,
  completionGate = new CompletionGate(),
): void {
  registry.register(createFinishTaskTool(contextProvider, completionGate));
}

export function createFinishTaskTool(
  contextProvider: CompletionGateContextProvider,
  completionGate = new CompletionGate(),
): ToolDefinition<unknown, CompletionDecision> {
  return {
    name: "finish_task",
    version: "tool:finish_task@2.0.0",
    normalizationVersion: "normalization:finish-task-v2",
    description:
      "Submit a completion intent bound to the observed code and diff, citing only trusted evidence IDs. Trace, safety, Artifact and operation facts are supplied independently by the system.",
    risk: "control",
    sideEffect: "none",
    retryPolicy: "safe",
    inputSchema: completionIntentSchema,
    outputSchema: completionDecisionSchema,
    availability: { available: true, reasonCode: null, message: null, checkedAt: systemClock.utcNow() },
    normalizeInput: (input) => ({ effectiveInput: input, transformations: [] }),
    claimResources: () => [{ key: "workspace:completion", mode: "read", scope: "workspace" }],
    execute: async (intent, context) => {
      try {
        const gateContext = await contextProvider.capture({
          sessionId: context.sessionId,
          runId: context.taskId,
          workspacePath: context.workspace,
          configVersion: context.configVersion,
        });
        return completionGate.evaluate(intent, gateContext);
      } catch {
        return completionGate.contextUnavailable(
          intent,
          "A trusted completion provider failed.",
        );
      }
    },
  };
}
