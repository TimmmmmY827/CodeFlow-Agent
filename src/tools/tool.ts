import type { ZodType } from "zod";

export type ToolRisk = "automatic" | "task_authorized" | "single_confirmation" | "control";

export interface ToolExecutionContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly inputSchema: ZodType<TInput>;
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}
