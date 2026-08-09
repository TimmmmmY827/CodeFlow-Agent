export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ModelRequest {
  readonly input: string;
  readonly signal?: AbortSignal;
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
