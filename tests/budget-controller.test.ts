import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BudgetController,
  BudgetTimer,
  detectNoProgress,
} from "../src/policy/budget-controller.js";
import {
  BUDGET_SCHEMA_VERSION,
  ZERO_BUDGET_USAGE,
  budgetUsageSchema,
  type BudgetPolicy,
  type BudgetSnapshot,
} from "../src/policy/budget-contracts.js";
import type { Clock } from "../src/shared/contracts.js";

const policy: BudgetPolicy = {
  limits: {
    maxSteps: 10,
    maxToolCalls: 5,
    maxDurationMs: 1_000,
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    maxCostUsd: 1,
    maxRetriesPerOperation: 3,
    maxNoProgressCycles: 3,
  },
  softLimitRatio: 0.8,
  countWaitingTime: false,
};

describe("BudgetController", () => {
  it("evaluates all budget dimensions using committed plus reserved usage", () => {
    const controller = new BudgetController(policy);
    const snapshot = createSnapshot({
      usage: budgetUsageSchema.parse({ ...ZERO_BUDGET_USAGE, inputTokens: 700 }),
      reserved: budgetUsageSchema.parse({ ...ZERO_BUDGET_USAGE, inputTokens: 100 }),
    });

    expect(controller.evaluate(snapshot)).toMatchObject({
      outcome: "warn",
      allowed: true,
      violations: [{ dimension: "inputTokens", category: "budget_soft_limit" }],
    });
    expect(controller.evaluate(snapshot, budgetUsageSchema.parse({
      ...ZERO_BUDGET_USAGE,
      inputTokens: 201,
    }))).toMatchObject({
      outcome: "deny",
      allowed: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ dimension: "inputTokens", category: "budget_hard_limit" }),
      ]),
    });
  });

  it("never treats unknown cost as zero", () => {
    const controller = new BudgetController(policy);
    const decision = controller.evaluate(createSnapshot({
      usage: budgetUsageSchema.parse({ ...ZERO_BUDGET_USAGE, costUsd: null, costStatus: "unknown" }),
    }));

    expect(decision).toMatchObject({
      outcome: "deny",
      violations: [expect.objectContaining({ dimension: "costUsd", category: "pricing_unknown", usedAndReserved: null })],
    });
  });

  it("denies automatic retries for UNKNOWN side effects and per-operation overflow", () => {
    const controller = new BudgetController(policy);
    expect(controller.evaluateRetry({ attempt: 1, sideEffectStatus: "unknown" }).allowed).toBe(false);
    expect(controller.evaluateRetry({ attempt: 3, sideEffectStatus: "not_started" }).allowed).toBe(true);
    expect(controller.evaluateRetry({ attempt: 4, sideEffectStatus: "not_started" }).allowed).toBe(false);
    expect(controller.evaluateNoProgress(2).allowed).toBe(true);
    expect(controller.evaluateNoProgress(3).allowed).toBe(false);
  });

  it("stops repeated identical failures with first and last evidence", () => {
    const observations = [0, 1, 2].map(() => ({
      observationId: randomUUID(),
      toolName: "write_file",
      effectiveInputHash: `sha256:${"a".repeat(64)}`,
      errorCategory: "permission_denied",
      codeVersion: "git:abc",
    }));
    const result = detectNoProgress(observations, 3);
    expect(result).toEqual({
      cycles: 3,
      stopped: true,
      firstObservationId: observations[0]?.observationId,
      lastObservationId: observations[2]?.observationId,
    });
    expect(detectNoProgress([
      ...observations,
      { ...observations[2]!, observationId: randomUUID(), codeVersion: "git:def" },
    ], 3)).toMatchObject({ cycles: 1, stopped: false });
  });

  it("records active and waiting time from a monotonic clock", () => {
    let monotonic = 10;
    const clock: Clock = {
      utcNow: () => "2026-08-15T00:00:00.000Z",
      monotonicNowMs: () => monotonic,
    };
    const timer = new BudgetTimer(clock);
    monotonic = 30;
    timer.wait();
    monotonic = 80;
    timer.resume();
    monotonic = 90;

    expect(timer.stop()).toMatchObject({ activeDurationMs: 30, waitingDurationMs: 50 });
  });
});

function createSnapshot(overrides: Partial<Pick<BudgetSnapshot, "usage" | "reserved">> = {}): BudgetSnapshot {
  return {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    sessionId: randomUUID(),
    usage: overrides.usage ?? ZERO_BUDGET_USAGE,
    reserved: overrides.reserved ?? ZERO_BUDGET_USAGE,
    limits: policy.limits,
    pricingVersion: "pricing:test",
    countWaitingTime: policy.countWaitingTime,
    softLimitRatio: policy.softLimitRatio,
    limitStatus: "within",
    limitDimensions: [],
    updatedAt: "2026-08-15T00:00:00.000Z",
    lastLedgerSequence: -1,
  };
}
