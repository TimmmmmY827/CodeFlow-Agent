import { z } from "zod";

import {
  sideEffectStatusSchema,
  stableIdSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
  type StableId,
  type StructuredError,
} from "../shared/contracts.js";

export const BUDGET_SCHEMA_VERSION = 1;

const countLimitSchema = z.number().int().positive();
const countSchema = z.number().int().nonnegative();
const amountSchema = z.number().nonnegative().finite();

export const costStatusSchema = z.enum(["known", "partial", "unknown"]);
export type CostStatus = z.infer<typeof costStatusSchema>;

export const budgetLimitsSchema = z.object({
  maxSteps: countLimitSchema,
  maxToolCalls: countLimitSchema,
  maxDurationMs: z.number().positive().finite(),
  maxInputTokens: countLimitSchema,
  maxOutputTokens: countLimitSchema,
  maxCostUsd: amountSchema,
  maxRetriesPerOperation: countLimitSchema,
  maxNoProgressCycles: countLimitSchema,
});
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>;

export const budgetUsageSchema = z
  .object({
    steps: countSchema,
    toolCalls: countSchema,
    inputTokens: countSchema,
    outputTokens: countSchema,
    retries: countSchema,
    noProgressCycles: countSchema,
    activeDurationMs: amountSchema,
    waitingDurationMs: amountSchema,
    costUsd: amountSchema.nullable(),
    costStatus: costStatusSchema,
  })
  .superRefine((usage, refinement) => {
    if (usage.costStatus === "known" && usage.costUsd === null) {
      refinement.addIssue({ code: "custom", path: ["costUsd"], message: "Known cost must have a numeric value." });
    }
    if (usage.costStatus === "unknown" && usage.costUsd !== null) {
      refinement.addIssue({ code: "custom", path: ["costUsd"], message: "Unknown cost must be null." });
    }
  });
export type BudgetUsage = z.infer<typeof budgetUsageSchema>;

export const budgetDeltaSchema = z
  .object({
    steps: countSchema.default(0),
    toolCalls: countSchema.default(0),
    inputTokens: countSchema.default(0),
    outputTokens: countSchema.default(0),
    retries: countSchema.default(0),
    noProgressCycles: countSchema.default(0),
    activeDurationMs: amountSchema.default(0),
    waitingDurationMs: amountSchema.default(0),
    costUsd: amountSchema.nullable().default(0),
    costStatus: costStatusSchema.default("known"),
  })
  .superRefine((delta, refinement) => {
    if (delta.costStatus === "known" && delta.costUsd === null) {
      refinement.addIssue({ code: "custom", path: ["costUsd"], message: "Known cost must have a numeric value." });
    }
    if (delta.costStatus === "unknown" && delta.costUsd !== null) {
      refinement.addIssue({ code: "custom", path: ["costUsd"], message: "Unknown cost must be null." });
    }
  });
export type BudgetDelta = z.infer<typeof budgetDeltaSchema>;

export const budgetPolicySchema = z.object({
  limits: budgetLimitsSchema,
  softLimitRatio: z.number().positive().max(1),
  countWaitingTime: z.boolean(),
});
export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

export const budgetCostReconciliationSchema = z.object({
  /** Authoritative cumulative committed cost after reconciliation. */
  resolvedCostUsd: amountSchema,
  costStatus: z.enum(["known", "partial"]),
  pricingVersion: versionIdentifierSchema,
  reason: z.string().trim().min(1).max(1_024),
});
export type BudgetCostReconciliation = z.infer<typeof budgetCostReconciliationSchema>;

/** Central fallback used until C12 supplies the validated application config. */
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = Object.freeze({
  limits: {
    maxSteps: 80,
    maxToolCalls: 120,
    maxDurationMs: 20 * 60 * 1_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 200_000,
    maxCostUsd: 1,
    maxRetriesPerOperation: 3,
    maxNoProgressCycles: 3,
  },
  softLimitRatio: 0.8,
  countWaitingTime: false,
});

export const budgetSnapshotSchema = z.object({
  schemaVersion: z.literal(BUDGET_SCHEMA_VERSION),
  sessionId: stableIdSchema,
  usage: budgetUsageSchema,
  reserved: budgetUsageSchema,
  limits: budgetLimitsSchema,
  pricingVersion: versionIdentifierSchema.nullable(),
  countWaitingTime: z.boolean(),
  softLimitRatio: z.number().positive().max(1),
  limitStatus: z.enum(["within", "soft_limit", "hard_limit", "pricing_unknown"]),
  limitDimensions: z.array(z.enum([
    "steps",
    "toolCalls",
    "durationMs",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "retries",
    "noProgressCycles",
  ])),
  updatedAt: utcTimestampSchema,
  lastLedgerSequence: z.number().int().min(-1),
});
export type BudgetSnapshot = z.infer<typeof budgetSnapshotSchema>;

export const budgetEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("retry"),
    attempt: z.number().int().positive(),
    operationHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    sideEffectStatus: sideEffectStatusSchema,
  }),
  z.object({
    kind: z.literal("no_progress"),
    toolName: z.string().min(1),
    effectiveInputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    errorCategory: z.string().min(1),
    codeVersion: versionIdentifierSchema.nullable(),
    firstObservationId: stableIdSchema,
    lastObservationId: stableIdSchema,
  }),
]);
export type BudgetEvidence = z.infer<typeof budgetEvidenceSchema>;

export const budgetLedgerEntrySchema = z.object({
  schemaVersion: z.literal(BUDGET_SCHEMA_VERSION),
  entryId: stableIdSchema,
  sessionId: stableIdSchema,
  operationId: stableIdSchema,
  idempotencyKey: z.string().min(1).max(256),
  kind: z.enum(["reserve", "commit", "release", "adjust"]),
  ledgerSequence: z.number().int().nonnegative(),
  reservationId: stableIdSchema.nullable(),
  delta: budgetDeltaSchema,
  usageBasis: z.enum(["estimated", "actual", "conservative", "not_applicable"]),
  admission: z.enum(["allow", "warn", "recorded"]),
  warningDimensions: z.array(z.enum([
    "steps",
    "toolCalls",
    "durationMs",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "retries",
    "noProgressCycles",
  ])),
  costReconciliation: budgetCostReconciliationSchema.nullable(),
  reconciliationRequired: z.boolean(),
  evidence: budgetEvidenceSchema.nullable(),
  createdAt: utcTimestampSchema,
});
export type BudgetLedgerEntry = z.infer<typeof budgetLedgerEntrySchema>;

export interface InitializeBudgetInput {
  readonly sessionId: StableId;
  readonly policy: BudgetPolicy;
  readonly pricingVersion: string | null;
}

export interface BudgetMutationInput {
  readonly entryId: StableId;
  readonly sessionId: StableId;
  readonly operationId: StableId;
  readonly idempotencyKey: string;
}

export interface ReserveBudgetInput extends BudgetMutationInput {
  readonly delta: BudgetDelta;
  readonly evidence?: BudgetEvidence | null;
}

export interface CommitBudgetInput extends BudgetMutationInput {
  readonly reservationId: StableId;
  /** Null means the provider omitted usage; the complete reservation is settled conservatively. */
  readonly actual: BudgetDelta | null;
  readonly evidence?: BudgetEvidence | null;
}

export interface ReleaseBudgetInput extends BudgetMutationInput {
  readonly reservationId: StableId;
  readonly operationStarted: false;
}

export interface AdjustBudgetInput extends BudgetMutationInput {
  readonly delta: BudgetDelta;
  readonly evidence?: BudgetEvidence | null;
  readonly costReconciliation?: BudgetCostReconciliation | null;
}

export interface BudgetMutationResult {
  readonly status: "inserted" | "duplicate";
  readonly entry: BudgetLedgerEntry;
  /** The snapshot produced by the first successful application of this idempotency key. */
  readonly snapshot: BudgetSnapshot;
}

export interface BudgetLedger {
  initialize(input: InitializeBudgetInput): Promise<BudgetSnapshot>;
  getSnapshot(sessionId: StableId): Promise<BudgetSnapshot | null>;
  listEntries(sessionId: StableId): Promise<readonly BudgetLedgerEntry[]>;
  listOpenReservations(sessionId: StableId): Promise<readonly BudgetLedgerEntry[]>;
  reserve(input: ReserveBudgetInput): Promise<BudgetMutationResult>;
  commit(input: CommitBudgetInput): Promise<BudgetMutationResult>;
  release(input: ReleaseBudgetInput): Promise<BudgetMutationResult>;
  adjust(input: AdjustBudgetInput): Promise<BudgetMutationResult>;
}

/** Synchronous primitives for C08/C11 journals that already own a SQLite transaction. */
export interface TransactionalBudgetLedger {
  reserveWithinTransaction(input: ReserveBudgetInput): BudgetMutationResult;
  commitWithinTransaction(input: CommitBudgetInput): BudgetMutationResult;
  releaseWithinTransaction(input: ReleaseBudgetInput): BudgetMutationResult;
  adjustWithinTransaction(input: AdjustBudgetInput): BudgetMutationResult;
}

export class BudgetError extends Error {
  constructor(readonly details: StructuredError) {
    super(details.message);
    this.name = "BudgetError";
  }
}

export const ZERO_BUDGET_USAGE: BudgetUsage = Object.freeze({
  steps: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  retries: 0,
  noProgressCycles: 0,
  activeDurationMs: 0,
  waitingDurationMs: 0,
  costUsd: 0,
  costStatus: "known",
});

export function createBudgetError(
  category: string,
  message: string,
  retryable: boolean,
  recovery: string | null,
): BudgetError {
  return new BudgetError({ category, message, retryable, sideEffectStatus: "none", recovery });
}
