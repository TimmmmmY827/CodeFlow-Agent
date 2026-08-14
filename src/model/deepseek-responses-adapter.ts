import OpenAI from "openai";

import { elapsedMilliseconds, systemClock } from "../shared/contracts.js";
import { validateJsonValue, type JsonObject } from "../shared/json.js";
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
    const startedAt = systemClock.monotonicNowMs();
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
        cachedTokens: response.usage?.input_tokens_details.cached_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        costUsd: null,
        durationMs: elapsedMilliseconds(startedAt, systemClock.monotonicNowMs()),
        providerUsage: providerUsage(response.usage),
      },
    };
  }
}

function providerUsage(value: unknown): JsonObject {
  const jsonCompatible = JSON.parse(JSON.stringify(value ?? {})) as unknown;
  const validated = validateJsonValue(jsonCompatible);
  if (
    !validated.ok ||
    validated.value === null ||
    Array.isArray(validated.value) ||
    typeof validated.value !== "object"
  ) {
    throw new TypeError("Provider usage was not a JSON object.");
  }
  return validated.value as JsonObject;
}
