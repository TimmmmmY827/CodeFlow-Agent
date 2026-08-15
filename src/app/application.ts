import { AgentEventLoop } from "../agent/agent-event-loop.js";
import { CompletionGate } from "../completion/completion-gate.js";
import { ContextAssembler } from "../context/context-assembler.js";
import { InMemoryEventStore } from "../events/event-store.js";
import { BudgetController } from "../policy/budget-controller.js";
import { DEFAULT_BUDGET_POLICY } from "../policy/budget-contracts.js";
import { PermissionEngine } from "../policy/permission-engine.js";
import {
  createCancellationContext,
  type CancellationContext,
  type UtcTimestamp,
} from "../shared/contracts.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ToolRuntime } from "../tools/tool-runtime.js";

export interface ApplicationDescription {
  readonly name: "CodeFlow Agent";
  readonly phase: "D1_SCAFFOLD";
  readonly components: readonly string[];
}

export interface CodeFlowApplication {
  readonly eventLoop: AgentEventLoop;
  readonly contextAssembler: ContextAssembler;
  readonly toolRegistry: ToolRegistry;
  readonly toolRuntime: ToolRuntime;
  readonly permissionEngine: PermissionEngine;
  readonly budgetController: BudgetController;
  readonly completionGate: CompletionGate;
  cancellationContext(
    signal: AbortSignal,
    deadlineAt?: UtcTimestamp | null,
  ): CancellationContext;
  describe(): ApplicationDescription;
}

export function createApplication(): CodeFlowApplication {
  const eventStore = new InMemoryEventStore();
  const toolRegistry = new ToolRegistry();
  const permissionEngine = new PermissionEngine();

  return {
    eventLoop: new AgentEventLoop(eventStore),
    contextAssembler: new ContextAssembler(),
    toolRegistry,
    toolRuntime: new ToolRuntime(toolRegistry, permissionEngine),
    permissionEngine,
    budgetController: new BudgetController(DEFAULT_BUDGET_POLICY),
    completionGate: new CompletionGate(),
    cancellationContext: (signal, deadlineAt = null) =>
      createCancellationContext(signal, deadlineAt),
    describe: () => ({
      name: "CodeFlow Agent",
      phase: "D1_SCAFFOLD",
      components: [
        "AgentEventLoop",
        "ContextAssembler",
        "ModelAdapter",
        "ToolRegistry",
        "ToolRuntime",
        "PermissionEngine",
        "BudgetController",
        "AgentEvent",
        "StateReducer",
        "Storage",
        "Evaluation",
        "CompletionGate",
      ],
    }),
  };
}
