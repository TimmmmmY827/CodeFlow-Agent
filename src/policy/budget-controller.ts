export interface BudgetLimits {
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxDurationMs: number;
  readonly maxCostUsd: number;
}

export interface BudgetUsage {
  readonly steps: number;
  readonly toolCalls: number;
  readonly durationMs: number;
  readonly costUsd: number;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly violations: readonly string[];
}

export class BudgetController {
  constructor(readonly limits: BudgetLimits) {}

  evaluate(usage: BudgetUsage): BudgetDecision {
    const violations: string[] = [];
    if (usage.steps >= this.limits.maxSteps) violations.push("step limit reached");
    if (usage.toolCalls >= this.limits.maxToolCalls) violations.push("tool-call limit reached");
    if (usage.durationMs >= this.limits.maxDurationMs) violations.push("duration limit reached");
    if (usage.costUsd >= this.limits.maxCostUsd) violations.push("cost limit reached");
    return { allowed: violations.length === 0, violations };
  }
}
