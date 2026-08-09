import OpenAI from "openai";

import type { ModelAdapter, ModelRequest, ModelResponse } from "./model-adapter.js";

export interface DeepSeekResponsesOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly reasoningEffort?: "low" | "medium" | "high";
}

export class DeepSeekResponsesAdapter implements ModelAdapter {
  readonly provider = "deepseek";
  readonly model: string;
  readonly #client: OpenAI;
  readonly #reasoningEffort: "low" | "medium" | "high";

  constructor(options: DeepSeekResponsesOptions) {
    this.model = options.model ?? "deepseek-v4-flash";
    this.#reasoningEffort = options.reasoningEffort ?? "high";
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? "https://api.deepseek.com",
    });
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.#client.responses.create(
      {
        model: this.model,
        input: request.input,
        reasoning: { effort: this.#reasoningEffort },
      },
      { signal: request.signal },
    );

    return {
      responseId: response.id,
      outputText: response.output_text,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
  }
}
