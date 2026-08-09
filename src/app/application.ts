import { AgentEventLoop } from "../agent/agent-event-loop.js";
import { ContextAssembler } from "../context/context-assembler.js";
import { InMemoryEventStore } from "../events/event-store.js";
import { BudgetController } from "../policy/budget-controller.js";
import { PermissionEngine } from "../policy/permission-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";

export interface ApplicationDescription {
  readonly name: "CodeFlow Agent";
  readonly phase: "D1_SCAFFOLD";
  readonly components: readonly string[];
}

export interface CodeFlowApplication {
  readonly eventLoop: AgentEventLoop;
  readonly contextAssembler: ContextAssembler;
  readonly toolRegistry: ToolRegistry;
  readonly permissionEngine: PermissionEngine;
  readonly budgetController: BudgetController;
  describe(): ApplicationDescription;
}

export function createApplication(): CodeFlowApplication {
  const eventStore = new InMemoryEventStore();

  return {
    eventLoop: new AgentEventLoop(eventStore),
    contextAssembler: new ContextAssembler(),
    toolRegistry: new ToolRegistry(),
    permissionEngine: new PermissionEngine(),
    budgetController: new BudgetController({
      maxSteps: 80,
      maxToolCalls: 120,
      maxDurationMs: 20 * 60 * 1_000,
      maxCostUsd: 1,
    }),
    describe: () => ({
      name: "CodeFlow Agent",
      phase: "D1_SCAFFOLD",
      components: [
        "AgentEventLoop",
        "ContextAssembler",
        "ModelAdapter",
        "ToolRegistry",
        "PermissionEngine",
        "BudgetController",
        "AgentEvent",
        "StateReducer",
        "Storage",
        "Evaluation",
      ],
    }),
  };
}
