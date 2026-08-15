import { describe, expect, it, vi } from "vitest";

import {
  DeepSeekChatAdapter,
  type DeepSeekCompletionTransport,
} from "../src/model/deepseek-chat-adapter.js";
import type { ModelToolCall } from "../src/model/model-adapter.js";
import type { Clock } from "../src/shared/contracts.js";
import type { JsonObject } from "../src/shared/json.js";

const NOW = "2026-08-15T04:00:00.000Z";

describe("DeepSeekChatAdapter", () => {
  it("uses the official non-streaming chat protocol and returns text usage", async () => {
    const requests: JsonObject[] = [];
    const signals: AbortSignal[] = [];
    const controller = new AbortController();
    const adapter = createAdapter(async (request, options) => {
      requests.push(request);
      signals.push(options.signal);
      return completion({
        content: "I inspected the repository.",
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
          prompt_tokens_details: { cached_tokens: 3 },
          prompt_cache_hit_tokens: 3,
        },
      });
    });

    const result = await adapter.generate({
      input: "Inspect the repository",
      signal: controller.signal,
      deadlineAt: null,
      maxOutputTokens: 256,
    });

    expect(requests).toEqual([
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "Inspect the repository" }],
        stream: false,
        n: 1,
        thinking: { type: "disabled" },
        max_tokens: 256,
      },
    ]);
    expect(signals[0]).toBe(controller.signal);
    expect(result).toEqual({
      responseId: "response-1",
      model: "deepseek-v4-flash",
      outputText: "I inspected the repository.",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cachedTokens: 3,
        totalTokens: 20,
        costUsd: null,
        durationMs: 25,
        providerUsage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
          prompt_tokens_details: { cached_tokens: 3 },
          prompt_cache_hit_tokens: 3,
        },
      },
    });
  });

  it("preserves complete single and parallel tool calls in provider order", async () => {
    const requests: JsonObject[] = [];
    const adapter = createAdapter(async (request) => {
      requests.push(request);
      return completion({
        finishReason: "tool_calls",
        content: null,
        toolCalls: [
          providerToolCall("call-1", "list_files", "{\"path\":\"src\"}"),
          providerToolCall("call-2", "git_status", "{}"),
        ],
      });
    });

    const result = await adapter.generate({
      input: [{ type: "message", role: "user", content: "Inspect the code" }],
      tools: [
        {
          name: "list_files",
          description: "List files below a path",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          name: "git_status",
          description: "Read the current Git status",
          parameters: { type: "object", properties: {} },
        },
      ],
      toolChoice: "auto",
      signal: new AbortController().signal,
      deadlineAt: null,
    });

    expect(requests[0]).toMatchObject({
      stream: false,
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "list_files",
            description: "List files below a path",
            strict: false,
          },
        },
        {
          type: "function",
          function: { name: "git_status", strict: false },
        },
      ],
    });
    expect(result.toolCalls).toEqual([
      {
        callId: "call-1",
        name: "list_files",
        argumentsJson: "{\"path\":\"src\"}",
        arguments: { path: "src" },
      },
      {
        callId: "call-2",
        name: "git_status",
        argumentsJson: "{}",
        arguments: {},
      },
    ]);
  });

  it("rebuilds local transcript tool calls and results without provider session state", async () => {
    let request: JsonObject | null = null;
    const adapter = createAdapter(async (value) => {
      request = value;
      return completion({ content: "The repository is clean." });
    });
    const previousCall: ModelToolCall = {
      callId: "call-status",
      name: "git_status",
      argumentsJson: "{}",
      arguments: {},
    };

    await adapter.generate({
      input: [
        { type: "message", role: "system", content: "Use read-only tools." },
        { type: "message", role: "user", content: "Inspect the repository." },
        { type: "assistant_tool_calls", content: null, calls: [previousCall] },
        { type: "tool_result", callId: "call-status", output: "clean" },
      ],
      signal: new AbortController().signal,
      deadlineAt: null,
    });

    expect(request).toMatchObject({
      messages: [
        { role: "system", content: "Use read-only tools." },
        { role: "user", content: "Inspect the repository." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-status",
              type: "function",
              function: { name: "git_status", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-status", content: "clean" },
      ],
    });
    expect(request).not.toHaveProperty("previous_response_id");
  });

  it("rejects incomplete or invalid tool arguments without guessing a repair", async () => {
    const transport = vi.fn<DeepSeekCompletionTransport>().mockResolvedValue(
      completion({
        finishReason: "tool_calls",
        toolCalls: [providerToolCall("call-bad", "read_file", "{\"path\":")],
      }),
    );
    const adapter = createAdapter(transport);

    await expect(adapter.generate(request())).rejects.toMatchObject({
      category: "model_invalid_tool_call",
      retryable: false,
      providerResponseId: "response-1",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("fails closed on protocol drift and never issues an adapter retry", async () => {
    const transport = vi.fn<DeepSeekCompletionTransport>()
      .mockResolvedValue({ id: "response-1", choices: [] });
    const adapter = createAdapter(transport);

    await expect(adapter.generate(request())).rejects.toMatchObject({
      category: "model_protocol_changed",
      retryable: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("maps rate limits to stable retry advice without exposing provider messages", async () => {
    const providerError = Object.assign(new Error("Authorization: secret-key"), {
      status: 429,
      headers: new Headers({ "retry-after": "2", "x-request-id": "req-provider" }),
    });
    const transport = vi.fn<DeepSeekCompletionTransport>().mockRejectedValue(providerError);
    const adapter = createAdapter(transport);

    await expect(adapter.generate(request())).rejects.toMatchObject({
      category: "model_rate_limited",
      message: "DeepSeek rate limited the request.",
      retryable: true,
      retryAfterMs: 2_000,
      providerResponseId: "req-provider",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider after cancellation or an expired deadline", async () => {
    const transport = vi.fn<DeepSeekCompletionTransport>();
    const controller = new AbortController();
    controller.abort();
    const adapter = createAdapter(transport);

    await expect(adapter.generate({ ...request(), signal: controller.signal })).rejects.toMatchObject({
      category: "cancelled",
      retryable: false,
    });
    await expect(adapter.generate({
      ...request(),
      deadlineAt: "2026-08-15T03:59:59.999Z",
    })).rejects.toMatchObject({ category: "model_timeout" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts an in-flight provider request when the caller cancels", async () => {
    const controller = new AbortController();
    const transport = vi.fn<DeepSeekCompletionTransport>().mockImplementation(
      async (_providerRequest, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    );
    const adapter = createAdapter(transport);
    const pending = adapter.generate({ ...request(), signal: controller.signal });
    controller.abort(new Error("stop"));

    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported strict schemas before using the standard endpoint", async () => {
    const transport = vi.fn<DeepSeekCompletionTransport>();
    const adapter = createAdapter(transport);

    await expect(adapter.generate({
      ...request(),
      tools: [{
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
        strict: true,
      }],
    })).rejects.toMatchObject({ category: "model_capability_unsupported" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("declares the intentionally narrow MVP capability matrix", () => {
    expect(createAdapter(async () => completion({})).capabilities()).toEqual({
      protocolVersion: "model-adapter:v1",
      streaming: false,
      toolCalling: true,
      parallelToolCalls: true,
      reasoningContinuation: false,
      serverSideTools: false,
    });
  });
});

function createAdapter(transport: DeepSeekCompletionTransport): DeepSeekChatAdapter {
  return new DeepSeekChatAdapter({ transport, clock: testClock() });
}

function request() {
  return {
    input: "Inspect the repository",
    signal: new AbortController().signal,
    deadlineAt: null,
  } as const;
}

function testClock(): Clock {
  const monotonic = [100, 125];
  return {
    utcNow: () => NOW,
    monotonicNowMs: () => monotonic.shift() ?? 125,
  };
}

function providerToolCall(id: string, name: string, argumentsJson: string) {
  return { id, type: "function", function: { name, arguments: argumentsJson } } as const;
}

function completion(options: {
  readonly content?: string | null;
  readonly finishReason?: string;
  readonly toolCalls?: readonly ReturnType<typeof providerToolCall>[];
  readonly usage?: JsonObject;
}) {
  return {
    id: "response-1",
    model: "deepseek-v4-flash",
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason ?? "stop",
        message: {
          role: "assistant",
          content: options.content ?? "done",
          tool_calls: options.toolCalls,
        },
      },
    ],
    usage: options.usage ?? {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}
