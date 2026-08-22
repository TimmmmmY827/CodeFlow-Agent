import type { ZodType } from "zod";

import type {
  CancellationContext,
  StableId,
  StructuredError,
  ToolRetryPolicy,
  ToolRisk,
  ToolSideEffect,
  UtcTimestamp,
} from "../shared/contracts.js";

export type { ToolRetryPolicy, ToolRisk, ToolSideEffect } from "../shared/contracts.js";

export interface ToolExecutionContext extends CancellationContext {
  readonly workspace: string;
  readonly codeVersion: string | null;
  readonly diffHash: string | null;
  readonly configVersion: string;
  readonly sessionId: StableId;
  readonly taskId: StableId;
}

export interface ToolAvailability {
  readonly available: boolean;
  readonly reasonCode: string | null;
  readonly message: string | null;
  readonly checkedAt: UtcTimestamp;
}

export interface ToolContractIdentity {
  readonly name: string;
  readonly version: string;
  readonly inputSchemaHash: string;
  readonly outputSchemaHash: string;
  readonly normalizationVersion: string;
}

export interface InputTransformation {
  readonly field: string;
  readonly ruleCode: string;
  readonly beforeHash: string;
  readonly afterHash: string;
}

export interface NormalizedToolInput<TInput> {
  readonly effectiveInput: TInput;
  readonly transformations: readonly InputTransformation[];
}

export interface ResourceClaim {
  readonly key: string;
  readonly mode: "read" | "write";
  readonly scope: "workspace" | "path" | "repository" | "provider_object";
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly version: string;
  readonly normalizationVersion: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly sideEffect: ToolSideEffect;
  readonly retryPolicy: ToolRetryPolicy;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  readonly availability: ToolAvailability;
  readonly normalizeInput: (input: TInput) => NormalizedToolInput<TInput>;
  readonly claimResources: (input: TInput) => readonly ResourceClaim[];
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}

export interface RegisteredToolDefinition<TInput = unknown, TOutput = unknown>
  extends ToolDefinition<TInput, TOutput> {
  readonly contract: ToolContractIdentity;
}

/** A provider may reject an operation with a stable, user-actionable category. */
export class ToolExecutionError extends Error {
  constructor(readonly details: StructuredError) {
    super(details.message);
    this.name = "ToolExecutionError";
  }
}

// ToolRegistry erases concrete input/output types only after ToolRuntime has validated the input schema.
// eslint is not used in the MVP scaffold, so `any` is intentionally limited to this boundary alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegisteredToolDefinition = RegisteredToolDefinition<any, any>;
