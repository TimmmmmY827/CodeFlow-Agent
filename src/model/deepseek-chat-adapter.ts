import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions/completions";
import { z } from "zod";

import {
  elapsedMilliseconds,
  systemClock,
  type Clock,
} from "../shared/contracts.js";
import {
  canonicalJson,
  validateJsonValue,
  type JsonObject,
  type JsonValue,
} from "../shared/json.js";
import {
  MODEL_ADAPTER_PROTOCOL_VERSION,
  ModelAdapterError,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelInputItem,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelToolDefinition,
} from "./model-adapter.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const providerToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const providerResponseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  choices: z.array(
    z.object({
      index: z.number().int(),
      finish_reason: z.string().min(1),
      message: z.object({
        content: z.string().nullable(),
        tool_calls: z.array(providerToolCallSchema).optional(),
      }),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

export interface DeepSeekCompletionRequestOptions {
  readonly signal: AbortSignal;
}

/** Testable provider boundary. SDK-specific types remain inside this provider module. */
export type DeepSeekCompletionTransport = (
  request: JsonObject,
  options: DeepSeekCompletionRequestOptions,
) => Promise<unknown>;

export interface DeepSeekChatOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly transport?: DeepSeekCompletionTransport;
  readonly clock?: Clock;
}

export class DeepSeekChatAdapter implements ModelAdapter {
  readonly provider = "deepseek";
  readonly model: string;
  readonly #baseURL: string;
  readonly #transport: DeepSeekCompletionTransport;
  readonly #clock: Clock;

  constructor(options: DeepSeekChatOptions) {
    this.model = requireNonEmpty(options.model ?? "deepseek-v4-flash", "model");
    this.#baseURL = normalizeBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
    this.#clock = options.clock ?? systemClock;
    const timeout = options.timeoutMs ?? 10 * 60 * 1_000;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new TypeError("timeoutMs must be a positive integer.");
    }

    if (options.transport) {
      this.#transport = options.transport;
      return;
    }

    const apiKey = requireNonEmpty(options.apiKey ?? "", "apiKey");
    const client = new OpenAI({
      apiKey,
      baseURL: this.#baseURL,
      maxRetries: 0,
      timeout,
    });
    this.#transport = async (request, requestOptions) =>
      client.chat.completions.create(
        request as unknown as ChatCompletionCreateParamsNonStreaming,
        { signal: requestOptions.signal },
      );
  }

  capabilities(): ModelCapabilities {
    return {
      protocolVersion: MODEL_ADAPTER_PROTOCOL_VERSION,
      streaming: false,
      toolCalling: true,
      parallelToolCalls: true,
      reasoningContinuation: false,
      serverSideTools: false,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    validateRequest(request, this.#baseURL);
    throwIfCancelled(request, this.#clock);

    const providerRequest = createProviderRequest(this.model, request);
    const providerCancellation = createProviderCancellation(request, this.#clock);
    const startedAt = this.#clock.monotonicNowMs();
    try {
      const rawResponse = await this.#transport(providerRequest, {
        signal: providerCancellation.signal,
      });
      const response = parseProviderResponse(rawResponse);
      const choice = response.choices[0];
      if (!choice || response.choices.length !== 1 || choice.index !== 0) {
        throw protocolFailure("DeepSeek returned an unexpected choice set.", response.id);
      }

      const toolCalls = parseToolCalls(choice.message.tool_calls ?? [], response.id);
      if (choice.finish_reason === "tool_calls" && toolCalls.length === 0) {
        throw protocolFailure("DeepSeek reported tool_calls without a complete tool call.", response.id);
      }
      if (choice.finish_reason !== "tool_calls" && toolCalls.length > 0) {
        throw protocolFailure("DeepSeek returned tool calls with a mismatched finish reason.", response.id);
      }

      const providerUsage = asJsonObject(response.usage ?? {});
      const usage = response.usage;
      return {
        responseId: response.id,
        model: response.model,
        outputText: choice.message.content ?? "",
        toolCalls,
        finishReason: choice.finish_reason,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
          costUsd: null,
          durationMs: elapsedMilliseconds(startedAt, this.#clock.monotonicNowMs()),
          providerUsage,
        },
      };
    } catch (error) {
      if (error instanceof ModelAdapterError) throw error;
      throw translateProviderError(error, request, providerCancellation.deadlineReached());
    } finally {
      providerCancellation.dispose();
    }
  }
}

function validateRequest(request: ModelRequest, baseURL: string): void {
  if (!request || typeof request !== "object") {
    throw invalidRequest("Model request must be an object.");
  }
  if (!request.signal || typeof request.signal.aborted !== "boolean" ||
      typeof request.signal.addEventListener !== "function") {
    throw invalidRequest("Model request signal must be an AbortSignal.");
  }
  if (request.deadlineAt !== null &&
      (typeof request.deadlineAt !== "string" || Number.isNaN(Date.parse(request.deadlineAt)))) {
    throw invalidRequest("Model request deadlineAt must be a valid UTC timestamp or null.");
  }
  validateInput(request.input);
  if (request.maxOutputTokens !== undefined &&
      (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)) {
    throw invalidRequest("maxOutputTokens must be a positive integer.");
  }

  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    throw invalidRequest("Model tools must be an array.");
  }
  if (request.toolChoice !== undefined &&
      !(["auto", "none", "required"] as const).includes(request.toolChoice)) {
    throw invalidRequest("Model toolChoice is invalid.");
  }
  const tools = request.tools ?? [];
  if (tools.length > 128) throw invalidRequest("DeepSeek accepts at most 128 tools.");
  const names = new Set<string>();
  for (const tool of tools) {
    validateToolDefinition(tool, baseURL);
    if (names.has(tool.name)) throw invalidRequest(`Duplicate model tool name: ${tool.name}`);
    names.add(tool.name);
  }
  if (tools.length === 0 && request.toolChoice && request.toolChoice !== "none") {
    throw invalidRequest("toolChoice requires at least one tool.");
  }
}

function validateInput(input: ModelRequest["input"]): void {
  if (typeof input === "string") {
    if (input.trim().length === 0) throw invalidRequest("Model input must not be empty.");
    return;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest("Model input items must not be empty.");
  }
  for (const item of input) {
    if (!item || typeof item !== "object") throw invalidRequest("Model input item is invalid.");
    if (item.type === "message") {
      if (!(["system", "user", "assistant"] as const).includes(item.role) ||
          typeof item.content !== "string" || item.content.trim().length === 0) {
        throw invalidRequest("Message role and content must be valid.");
      }
      continue;
    }
    if (item.type === "tool_result") {
      if (typeof item.callId !== "string" || item.callId.trim().length === 0 ||
          typeof item.output !== "string") {
        throw invalidRequest("Tool result callId and output must be valid strings.");
      }
      continue;
    }
    if (item.type === "assistant_tool_calls") {
      if ((item.content !== null && typeof item.content !== "string") ||
          !Array.isArray(item.calls) || item.calls.length === 0) {
        throw invalidRequest("Assistant tool calls must contain a valid call list.");
      }
      const callIds = new Set<string>();
      for (const call of item.calls) {
        validateTranscriptCall(call);
        if (callIds.has(call.callId)) throw invalidRequest(`Duplicate transcript callId: ${call.callId}`);
        callIds.add(call.callId);
      }
      continue;
    }
    throw invalidRequest("Unsupported model input item type.");
  }
}

function validateTranscriptCall(call: ModelToolCall): void {
  if (!call || typeof call !== "object" || typeof call.callId !== "string" ||
      call.callId.trim().length === 0 || typeof call.name !== "string" ||
      !TOOL_NAME_PATTERN.test(call.name) || typeof call.argumentsJson !== "string") {
    throw invalidRequest("Transcript tool call identity is invalid.");
  }
  const parsed = parseArguments(call.argumentsJson, call.callId, null);
  const validatedArguments = validateJsonValue(call.arguments);
  if (!validatedArguments.ok || validatedArguments.value === null ||
      Array.isArray(validatedArguments.value) || typeof validatedArguments.value !== "object" ||
      canonicalJson(parsed) !== canonicalJson(validatedArguments.value)) {
    throw invalidRequest("Transcript tool call arguments do not match argumentsJson.");
  }
}

function validateToolDefinition(tool: ModelToolDefinition, baseURL: string): void {
  if (!tool || typeof tool !== "object" || typeof tool.name !== "string" ||
      !TOOL_NAME_PATTERN.test(tool.name)) {
    throw invalidRequest("Tool names must contain 1-64 letters, digits, underscores, or dashes.");
  }
  if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
    throw invalidRequest("Tool description must not be empty.");
  }
  const parameters = validateJsonValue(tool.parameters);
  if (!parameters.ok || parameters.value === null || Array.isArray(parameters.value) ||
      typeof parameters.value !== "object") {
    throw invalidRequest(`Tool ${tool.name} parameters must be a JSON object.`);
  }
  if (tool.strict === true && !isBetaBaseURL(baseURL)) {
    throw new ModelAdapterError({
      category: "model_capability_unsupported",
      message: "DeepSeek strict tool schemas require the beta API endpoint.",
      retryable: false,
      recovery: "Use the DeepSeek beta endpoint or disable strict tool schemas.",
      retryAfterMs: null,
      providerResponseId: null,
    });
  }
}

function createProviderRequest(model: string, request: ModelRequest): JsonObject {
  const tools = request.tools ?? [];
  const body: Record<string, JsonValue> = {
    model,
    messages: createProviderMessages(request.input),
    stream: false,
    n: 1,
    thinking: { type: "disabled" },
  };
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
      },
    }));
    body.tool_choice = request.toolChoice ?? "auto";
    body.parallel_tool_calls = true;
  }
  return body;
}

function createProviderMessages(input: ModelRequest["input"]): readonly JsonValue[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return input.map((item): JsonObject => toProviderMessage(item));
}

function toProviderMessage(item: ModelInputItem): JsonObject {
  if (item.type === "message") return { role: item.role, content: item.content };
  if (item.type === "tool_result") {
    return { role: "tool", tool_call_id: item.callId, content: item.output };
  }
  return {
    role: "assistant",
    content: item.content,
    tool_calls: item.calls.map((call) => ({
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson },
    })),
  };
}

function parseProviderResponse(rawResponse: unknown): z.infer<typeof providerResponseSchema> {
  const parsed = providerResponseSchema.safeParse(rawResponse);
  if (!parsed.success) throw protocolFailure("DeepSeek response did not match the pinned protocol.", null);
  return parsed.data;
}

function parseToolCalls(
  rawCalls: readonly z.infer<typeof providerToolCallSchema>[],
  responseId: string,
): readonly ModelToolCall[] {
  const callIds = new Set<string>();
  return rawCalls.map((rawCall) => {
    if (!TOOL_NAME_PATTERN.test(rawCall.function.name) || callIds.has(rawCall.id)) {
      throw new ModelAdapterError({
        category: "model_invalid_tool_call",
        message: "DeepSeek returned an invalid or duplicate tool call identity.",
        retryable: false,
        recovery: "Record the response for audit and ask the model to re-plan.",
        retryAfterMs: null,
        providerResponseId: responseId,
      });
    }
    callIds.add(rawCall.id);
    return {
      callId: rawCall.id,
      name: rawCall.function.name,
      argumentsJson: rawCall.function.arguments,
      arguments: parseArguments(rawCall.function.arguments, rawCall.id, responseId),
    };
  });
}

function parseArguments(argumentsJson: string, callId: string, responseId: string | null): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw invalidToolArguments(callId, responseId);
  }
  const validated = validateJsonValue(parsed);
  if (!validated.ok || validated.value === null || Array.isArray(validated.value) ||
      typeof validated.value !== "object") {
    throw invalidToolArguments(callId, responseId);
  }
  return validated.value as JsonObject;
}

function invalidToolArguments(callId: string, responseId: string | null): ModelAdapterError {
  return new ModelAdapterError({
    category: "model_invalid_tool_call",
    message: `DeepSeek returned invalid JSON object arguments for tool call ${callId}.`,
    retryable: false,
    recovery: "Record the response for audit and ask the model to re-plan.",
    retryAfterMs: null,
    providerResponseId: responseId,
  });
}

function asJsonObject(value: unknown): JsonObject {
  const validated = validateJsonValue(value);
  if (!validated.ok || validated.value === null || Array.isArray(validated.value) ||
      typeof validated.value !== "object") {
    throw protocolFailure("Provider data was not a JSON object.", null);
  }
  return validated.value as JsonObject;
}

function throwIfCancelled(request: ModelRequest, clock: Clock): void {
  if (request.signal.aborted) throw cancelledFailure();
  if (request.deadlineAt !== null && Date.parse(request.deadlineAt) <= Date.parse(clock.utcNow())) {
    throw timeoutFailure();
  }
}

function createProviderCancellation(request: ModelRequest, clock: Clock): {
  readonly signal: AbortSignal;
  readonly deadlineReached: () => boolean;
  readonly dispose: () => void;
} {
  if (request.deadlineAt === null) {
    return { signal: request.signal, deadlineReached: () => false, dispose: () => undefined };
  }

  const controller = new AbortController();
  let deadlineReached = false;
  const onAbort = (): void => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", onAbort, { once: true });
  const delay = Math.max(0, Date.parse(request.deadlineAt) - Date.parse(clock.utcNow()));
  const timer = setTimeout(() => {
    deadlineReached = true;
    controller.abort(new Error("Model deadline exceeded."));
  }, delay);
  return {
    signal: controller.signal,
    deadlineReached: () => deadlineReached,
    dispose: () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    },
  };
}

function translateProviderError(
  error: unknown,
  request: ModelRequest,
  deadlineReached: boolean,
): ModelAdapterError {
  if (request.signal.aborted) return cancelledFailure();
  if (deadlineReached) return timeoutFailure();

  const status = numericProperty(error, "status");
  const code = [stringProperty(error, "code"), stringProperty(error, "name")]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  const providerMessage = stringProperty(error, "message")?.toLowerCase() ?? "";
  const responseId = headerValue(error, "x-request-id") ??
    stringProperty(error, "request_id") ?? stringProperty(error, "requestID");
  if (status === 401 || status === 403) {
    return providerFailure("model_auth_failed", false, "DeepSeek authentication failed.",
      "Check DEEPSEEK_API_KEY without exposing it in logs.", null, responseId);
  }
  if (status === 429) {
    return providerFailure("model_rate_limited", true, "DeepSeek rate limited the request.",
      "Retry only if C11 and C04 allow another attempt.", retryAfter(error), responseId);
  }
  if (status === 408 || status === 504 || code.includes("timeout")) return timeoutFailure(responseId);
  if (status === 400 && (code.includes("context") || code.includes("length") ||
      providerMessage.includes("context length") || providerMessage.includes("maximum context"))) {
    return providerFailure("model_context_overflow", true, "DeepSeek rejected an oversized context.",
      "Ask C06 to compact the context before one controlled retry.", null, responseId);
  }
  if (status !== null && status >= 500) {
    return providerFailure("model_service_unavailable", true, "DeepSeek is temporarily unavailable.",
      "Retry only if C11 and C04 allow another attempt.", retryAfter(error), responseId);
  }
  if (status === 400 || status === 404 || status === 422) {
    return providerFailure("model_invalid_request", false, "DeepSeek rejected the model request.",
      "Inspect the model configuration and provider-neutral tool schemas.", null, responseId);
  }
  return providerFailure("model_request_failed", true, "The DeepSeek request failed before completion.",
    "Inspect provider availability before retrying through C11.", null, responseId);
}

function retryAfter(error: unknown): number | null {
  const milliseconds = headerValue(error, "retry-after-ms");
  if (milliseconds !== null) {
    const parsed = Number(milliseconds);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const value = headerValue(error, "retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function headerValue(error: unknown, name: string): string | null {
  if (!error || typeof error !== "object") return null;
  const headers = Reflect.get(error, "headers") as unknown;
  if (headers && typeof headers === "object" && "get" in headers) {
    const getHeader = Reflect.get(headers, "get") as unknown;
    if (typeof getHeader !== "function") return null;
    const value = Reflect.apply(getHeader, headers, [name]) as unknown;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function numericProperty(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const property = Reflect.get(value, key) as unknown;
  return typeof property === "number" ? property : null;
}

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property = Reflect.get(value, key) as unknown;
  return typeof property === "string" ? property : null;
}

function invalidRequest(message: string): ModelAdapterError {
  return providerFailure("model_invalid_request", false, message,
    "Correct the request before calling the provider.", null, null);
}

function protocolFailure(message: string, responseId: string | null): ModelAdapterError {
  return providerFailure("model_protocol_changed", false, message,
    "Stop the session and update the pinned DeepSeek protocol adapter.", null, responseId);
}

function cancelledFailure(): ModelAdapterError {
  return providerFailure("cancelled", false, "Model request was cancelled.", null, null, null);
}

function timeoutFailure(responseId: string | null = null): ModelAdapterError {
  return providerFailure("model_timeout", true, "DeepSeek did not complete before the deadline.",
    "Retry only if C11 and C04 allow another attempt.", null, responseId);
}

function providerFailure(
  category: string,
  retryable: boolean,
  message: string,
  recovery: string | null,
  retryAfterMs: number | null,
  providerResponseId: string | null,
): ModelAdapterError {
  return new ModelAdapterError({
    category,
    message,
    retryable,
    recovery,
    retryAfterMs,
    providerResponseId,
  });
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty.`);
  return value;
}

function normalizeBaseURL(value: string): string {
  const parsed = new URL(requireNonEmpty(value, "baseURL"));
  const localHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new TypeError("DeepSeek baseURL must use HTTPS outside localhost.");
  }
  return parsed.href.replace(/\/$/, "");
}

function isBetaBaseURL(baseURL: string): boolean {
  return new URL(baseURL).pathname.replace(/\/$/, "") === "/beta";
}
