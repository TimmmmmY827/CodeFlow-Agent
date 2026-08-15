import type { ZodType } from "zod";

import type {
  CancellationContext,
  StableId,
  StructuredError,
  ToolRetryPolicy,
  ToolRisk,
  ToolSideEffect,
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

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly sideEffect: ToolSideEffect;
  readonly retryPolicy: ToolRetryPolicy;
  readonly inputSchema: ZodType<TInput>;
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
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
