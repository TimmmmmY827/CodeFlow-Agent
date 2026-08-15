import type {
  CancellationContext,
  StructuredError,
  UsageRecord,
} from "../shared/contracts.js";
import type { JsonObject } from "../shared/json.js";

export const MODEL_ADAPTER_PROTOCOL_VERSION = "model-adapter:v1" as const;

export interface ModelUsage extends UsageRecord {
  readonly totalTokens: number;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict?: boolean;
}

export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  /** The exact provider argument bytes, retained for audit and transcript replay. */
  readonly argumentsJson: string;
  /** Parsed only after the complete non-streaming response has been received. */
  readonly arguments: JsonObject;
}

export type ModelInputItem =
  | {
      readonly type: "message";
      readonly role: "system" | "user" | "assistant";
      readonly content: string;
    }
  | {
      readonly type: "assistant_tool_calls";
      readonly content: string | null;
      readonly calls: readonly ModelToolCall[];
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly output: string;
    };

export interface ModelRequest extends CancellationContext {
  /** A string is the compatibility shorthand for one user message. */
  readonly input: string | readonly ModelInputItem[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly toolChoice?: "auto" | "none" | "required";
  readonly maxOutputTokens?: number;
}

export interface ModelResponse {
  readonly responseId: string;
  readonly model: string;
  readonly outputText: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason: string;
  readonly usage: ModelUsage;
}

export interface ModelCapabilities {
  readonly protocolVersion: typeof MODEL_ADAPTER_PROTOCOL_VERSION;
  readonly streaming: false;
  readonly toolCalling: true;
  readonly parallelToolCalls: true;
  readonly reasoningContinuation: false;
  readonly serverSideTools: false;
}

export interface ModelFailure extends StructuredError {
  readonly retryAfterMs: number | null;
  readonly providerResponseId: string | null;
}

export class ModelAdapterError extends Error implements ModelFailure {
  readonly category: string;
  readonly retryable: boolean;
  readonly sideEffectStatus = "none" as const;
  readonly recovery: string | null;
  readonly retryAfterMs: number | null;
  readonly providerResponseId: string | null;

  constructor(failure: Omit<ModelFailure, "sideEffectStatus">) {
    super(failure.message);
    this.name = "ModelAdapterError";
    this.category = failure.category;
    this.retryable = failure.retryable;
    this.recovery = failure.recovery;
    this.retryAfterMs = failure.retryAfterMs;
    this.providerResponseId = failure.providerResponseId;
  }
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  capabilities(): ModelCapabilities;
  /** Exactly one provider business attempt; retry decisions belong to C11. */
  generate(request: ModelRequest): Promise<ModelResponse>;
}
