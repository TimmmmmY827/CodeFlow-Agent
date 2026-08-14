import type { CancellationContext, UsageRecord } from "../shared/contracts.js";

export interface ModelUsage extends UsageRecord {
  readonly totalTokens: number;
}

export interface ModelRequest extends CancellationContext {
  readonly input: string;
}

export interface ModelResponse {
  readonly responseId: string;
  readonly outputText: string;
  readonly usage: ModelUsage;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}
