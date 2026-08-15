import type { Clock, SideEffectStatus, StableId } from "../shared/contracts.js";
import { elapsedMilliseconds } from "../shared/contracts.js";
import {
  budgetDeltaSchema,
  budgetPolicySchema,
  type BudgetDelta,
  type BudgetPolicy,
  type BudgetSnapshot,
  type BudgetUsage,
} from "./budget-contracts.js";

export type BudgetDimension =
  | "steps"
  | "toolCalls"
  | "durationMs"
  | "inputTokens"
  | "outputTokens"
  | "costUsd"
  | "retries"
  | "noProgressCycles";

export interface BudgetViolation {
  readonly dimension: BudgetDimension;
  readonly category: "budget_soft_limit" | "budget_hard_limit" | "pricing_unknown";
  readonly usedAndReserved: number | null;
  readonly limit: number;
}

export interface BudgetDecision {
  readonly outcome: "allow" | "warn" | "deny";
  readonly allowed: boolean;
  readonly violations: readonly BudgetViolation[];
}

export interface RetryDecisionInput {
  readonly attempt: number;
  readonly sideEffectStatus: SideEffectStatus;
}

export class BudgetController {
  readonly policy: BudgetPolicy;

  constructor(policy: BudgetPolicy) {
    this.policy = budgetPolicySchema.parse(policy);
  }

  evaluate(snapshot: BudgetSnapshot, requested: BudgetDelta = budgetDeltaSchema.parse({})): BudgetDecision {
    const current = addUsage(snapshot.usage, snapshot.reserved);
    const projected = addUsage(current, requested);
    const dimensions: readonly [BudgetDimension, number | null, number | null, number][] = [
      ["steps", current.steps, projected.steps, snapshot.limits.maxSteps],
      ["toolCalls", current.toolCalls, projected.toolCalls, snapshot.limits.maxToolCalls],
      ["durationMs", countedDuration(current, snapshot.countWaitingTime), countedDuration(projected, snapshot.countWaitingTime), snapshot.limits.maxDurationMs],
      ["inputTokens", current.inputTokens, projected.inputTokens, snapshot.limits.maxInputTokens],
      ["outputTokens", current.outputTokens, projected.outputTokens, snapshot.limits.maxOutputTokens],
      ["costUsd", current.costUsd, projected.costUsd, snapshot.limits.maxCostUsd],
    ];
    const violations: BudgetViolation[] = [];
    for (const [dimension, currentValue, projectedValue, limit] of dimensions) {
      if (dimension === "costUsd" && projectedValue === null) {
        violations.push({ dimension, category: "pricing_unknown", usedAndReserved: null, limit });
      } else if (
        currentValue !== null && projectedValue !== null &&
        (currentValue >= limit || projectedValue > limit)
      ) {
        violations.push({ dimension, category: "budget_hard_limit", usedAndReserved: projectedValue, limit });
      } else if (projectedValue !== null && projectedValue >= limit * snapshot.softLimitRatio) {
        violations.push({ dimension, category: "budget_soft_limit", usedAndReserved: projectedValue, limit });
      }
    }
    const denied = violations.some((violation) => violation.category !== "budget_soft_limit");
    return {
      outcome: denied ? "deny" : violations.length > 0 ? "warn" : "allow",
      allowed: !denied,
      violations,
    };
  }

  evaluateRetry(input: RetryDecisionInput): BudgetDecision {
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new RangeError("Retry attempt must be a positive integer.");
    }
    if (input.sideEffectStatus === "unknown") {
      return {
        outcome: "deny",
        allowed: false,
        violations: [{
          dimension: "retries",
          category: "budget_hard_limit",
          usedAndReserved: input.attempt,
          limit: this.policy.limits.maxRetriesPerOperation,
        }],
      };
    }
    const denied = input.attempt > this.policy.limits.maxRetriesPerOperation;
    return {
      outcome: denied ? "deny" : "allow",
      allowed: !denied,
      violations: denied ? [{
        dimension: "retries",
        category: "budget_hard_limit",
        usedAndReserved: input.attempt,
        limit: this.policy.limits.maxRetriesPerOperation,
      }] : [],
    };
  }

  evaluateNoProgress(cycles: number): BudgetDecision {
    if (!Number.isSafeInteger(cycles) || cycles < 0) throw new RangeError("No-progress cycles must be a nonnegative integer.");
    const denied = cycles >= this.policy.limits.maxNoProgressCycles;
    return {
      outcome: denied ? "deny" : "allow",
      allowed: !denied,
      violations: denied ? [{
        dimension: "noProgressCycles",
        category: "budget_hard_limit",
        usedAndReserved: cycles,
        limit: this.policy.limits.maxNoProgressCycles,
      }] : [],
    };
  }
}

export interface ProgressObservation {
  readonly observationId: StableId;
  readonly toolName: string;
  readonly effectiveInputHash: string;
  readonly errorCategory: string;
  readonly codeVersion: string | null;
}

export interface NoProgressDecision {
  readonly cycles: number;
  readonly stopped: boolean;
  readonly firstObservationId: StableId | null;
  readonly lastObservationId: StableId | null;
}

export function detectNoProgress(
  observations: readonly ProgressObservation[],
  maxNoProgressCycles: number,
): NoProgressDecision {
  if (!Number.isSafeInteger(maxNoProgressCycles) || maxNoProgressCycles < 1) {
    throw new RangeError("maxNoProgressCycles must be a positive integer.");
  }
  const last = observations.at(-1);
  if (!last) return { cycles: 0, stopped: false, firstObservationId: null, lastObservationId: null };
  let first = observations.length - 1;
  while (first > 0 && sameFailure(last, observations[first - 1] as ProgressObservation)) first -= 1;
  const cycles = observations.length - first;
  return {
    cycles,
    stopped: cycles >= maxNoProgressCycles,
    firstObservationId: observations[first]?.observationId ?? null,
    lastObservationId: last.observationId,
  };
}

export class BudgetTimer {
  #state: "active" | "waiting" | "stopped" = "active";
  #lastMonotonicMs: number;
  #activeDurationMs = 0;
  #waitingDurationMs = 0;

  constructor(private readonly clock: Clock) {
    this.#lastMonotonicMs = clock.monotonicNowMs();
  }

  wait(): void {
    this.#transition("waiting");
  }

  resume(): void {
    this.#transition("active");
  }

  stop(): BudgetDelta {
    this.#transition("stopped");
    return budgetDeltaSchema.parse({
      activeDurationMs: this.#activeDurationMs,
      waitingDurationMs: this.#waitingDurationMs,
    });
  }

  #transition(next: "active" | "waiting" | "stopped"): void {
    if (this.#state === "stopped") throw new Error("Budget timer is already stopped.");
    if (next === this.#state) return;
    const now = this.clock.monotonicNowMs();
    const elapsed = elapsedMilliseconds(this.#lastMonotonicMs, now);
    if (this.#state === "active") this.#activeDurationMs += elapsed;
    else this.#waitingDurationMs += elapsed;
    this.#lastMonotonicMs = now;
    this.#state = next;
  }
}

export function addUsage(left: BudgetUsage, right: BudgetUsage | BudgetDelta): BudgetUsage {
  const cost = addCost(left, right);
  return {
    steps: left.steps + right.steps,
    toolCalls: left.toolCalls + right.toolCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    retries: left.retries + right.retries,
    noProgressCycles: left.noProgressCycles + right.noProgressCycles,
    activeDurationMs: left.activeDurationMs + right.activeDurationMs,
    waitingDurationMs: left.waitingDurationMs + right.waitingDurationMs,
    ...cost,
  };
}

export function subtractUsage(left: BudgetUsage, right: BudgetDelta): BudgetUsage {
  const numeric = {
    steps: left.steps - right.steps,
    toolCalls: left.toolCalls - right.toolCalls,
    inputTokens: left.inputTokens - right.inputTokens,
    outputTokens: left.outputTokens - right.outputTokens,
    retries: left.retries - right.retries,
    noProgressCycles: left.noProgressCycles - right.noProgressCycles,
    activeDurationMs: left.activeDurationMs - right.activeDurationMs,
    waitingDurationMs: left.waitingDurationMs - right.waitingDurationMs,
  };
  if (Object.values(numeric).some((value) => value < 0)) throw new Error("Budget ledger would produce a negative balance.");
  const costUsd = left.costUsd !== null && right.costUsd !== null ? left.costUsd - right.costUsd : null;
  if (costUsd !== null && costUsd < -Number.EPSILON) throw new Error("Budget ledger would produce a negative cost balance.");
  return {
    ...numeric,
    costUsd: costUsd === null ? null : Math.max(0, costUsd),
    costStatus: costUsd === null ? "unknown" : left.costStatus === "partial" ? "partial" : "known",
  };
}

function addCost(left: BudgetUsage, right: BudgetUsage | BudgetDelta): Pick<BudgetUsage, "costUsd" | "costStatus"> {
  if (left.costStatus === "unknown" || right.costStatus === "unknown" || left.costUsd === null || right.costUsd === null) {
    return { costUsd: null, costStatus: "unknown" };
  }
  return {
    costUsd: left.costUsd + right.costUsd,
    costStatus: left.costStatus === "partial" || right.costStatus === "partial" ? "partial" : "known",
  };
}

function countedDuration(usage: BudgetUsage, countWaitingTime: boolean): number {
  return usage.activeDurationMs + (countWaitingTime ? usage.waitingDurationMs : 0);
}

function sameFailure(left: ProgressObservation, right: ProgressObservation): boolean {
  return left.toolName === right.toolName &&
    left.effectiveInputHash === right.effectiveInputHash &&
    left.errorCategory === right.errorCategory &&
    left.codeVersion === right.codeVersion;
}

export type { BudgetDelta, BudgetLimits, BudgetPolicy, BudgetSnapshot, BudgetUsage } from "./budget-contracts.js";
