import type { ZodType } from "zod";

export type ToolRisk = "automatic" | "task_authorized" | "single_confirmation" | "control";
export type ToolSideEffect = "none" | "workspace_write" | "external_write";
export type ToolRetryPolicy = "safe" | "reconcile" | "never";

export interface ToolExecutionContext {
  readonly workspace: string;
  readonly codeVersion: string | null;
  readonly configVersion: string;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly taskId: string;
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

// ToolRegistry erases concrete input/output types only after ToolRuntime has validated the input schema.
// eslint is not used in the MVP scaffold, so `any` is intentionally limited to this boundary alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
