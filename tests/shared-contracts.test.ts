import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApplication } from "../src/app/application.js";
import { createAgentEvent, createEventContext, parseAgentEvent } from "../src/events/agent-event.js";
import type { ModelAdapter } from "../src/model/model-adapter.js";
import {
  artifactReferenceSchema,
  cancellationFailure,
  codeSnapshotSchema,
  createCancellationContext,
  createCodeSnapshot,
  createPathReference,
  createStableId,
  createUtcTimestamp,
  elapsedMilliseconds,
  stableIdSchema,
  structuredErrorSchema,
  utcTimestampSchema,
  usageRecordSchema,
  versionIdentifierSchema,
  type CancellationContext,
} from "../src/shared/contracts.js";
import { validateJsonValue } from "../src/shared/json.js";

describe("shared contracts", () => {
  it("creates UUID stable IDs at object creation points", () => {
    const first = createStableId();
    const second = createStableId();

    expect(stableIdSchema.parse(first)).toBe(first);
    expect(second).not.toBe(first);
    expect(versionIdentifierSchema.parse("config:v1")).toBe("config:v1");
    expect(() => versionIdentifierSchema.parse("v1")).toThrow();
  });

  it("round-trips persistent shared records through JSON", () => {
    const records = [
      [
        codeSnapshotSchema,
        createCodeSnapshot({
          workspacePath: ".",
          codeVersion: "git:abc123",
          diffHash: "sha256:diff",
          configVersion: "config:v1",
        }),
      ],
      [
        usageRecordSchema,
        {
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: 3,
          costUsd: null,
          durationMs: 12.5,
          providerUsage: { input_tokens: 10, cache_hit: true },
        },
      ],
      [
        structuredErrorSchema,
        {
          category: "model_timeout",
          message: "The model timed out.",
          retryable: true,
          sideEffectStatus: "none",
          recovery: "Retry within the remaining budget.",
        },
      ],
      [
        artifactReferenceSchema,
        {
          artifactId: createStableId(),
          relativePath: "session/result.json",
          mediaType: "application/json",
          byteLength: 42,
          sha256: `sha256:${"a".repeat(64)}`,
          sensitivity: "normal",
        },
      ],
    ] as const;

    for (const [schema, record] of records) {
      const roundTripped = JSON.parse(JSON.stringify(record)) as unknown;
      expect(schema.parse(roundTripped)).toEqual(record);
    }
  });

  it("rejects unknown schema majors with a structured error", () => {
    const event = createAgentEvent({
      sessionId: createStableId(),
      taskId: createStableId(),
      sequence: 0,
      type: "session.created",
      context: createEventContext({ workspacePath: "." }),
    });

    expect(parseAgentEvent(JSON.parse(JSON.stringify(event)) as unknown)).toEqual({
      ok: true,
      value: event,
    });
    expect(parseAgentEvent({ ...event, futureOptionalField: "ignored by v1" })).toEqual({
      ok: true,
      value: event,
    });
    expect(parseAgentEvent({ ...event, futureOptionalField: new Date() })).toMatchObject({
      ok: false,
      error: { category: "not_json_serializable" },
    });

    const parsed = parseAgentEvent({ ...event, schemaVersion: 2 });

    expect(parsed).toMatchObject({
      ok: false,
      error: {
        category: "unsupported_schema_version",
        retryable: false,
        sideEffectStatus: "none",
      },
    });
  });

  it("rejects runtime-only and cyclic values at persistence boundaries", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolKeyed = { visible: true, [Symbol("hidden")]: "lost" };

    expect(validateJsonValue({ createdAt: new Date() })).toMatchObject({
      ok: false,
      error: { category: "not_json_serializable", path: "$.createdAt" },
    });
    expect(validateJsonValue(cyclic)).toMatchObject({
      ok: false,
      error: { category: "not_json_serializable", path: "$.self" },
    });
    expect(validateJsonValue(symbolKeyed)).toMatchObject({
      ok: false,
      error: { category: "not_json_serializable" },
    });
  });

  it("keeps normalized security paths separate from display paths", () => {
    const reference = createPathReference("src/index.ts", process.cwd());

    expect(path.isAbsolute(reference.normalizedPath)).toBe(true);
    expect(reference.displayPath).toBe("src/index.ts");
    expect(codeSnapshotSchema.safeParse({
      workspacePath: process.cwd(),
      codeVersion: null,
      diffHash: "sha256:diff",
      configVersion: "config:v1",
    }).success).toBe(false);
  });

  it("uses UTC timestamps and monotonic elapsed milliseconds", () => {
    expect(createUtcTimestamp(new Date("2026-08-09T12:34:56.789Z"))).toBe(
      "2026-08-09T12:34:56.789Z",
    );
    expect(elapsedMilliseconds(100.25, 112.75)).toBe(12.5);
    expect(() => elapsedMilliseconds(10, 9)).toThrow(RangeError);
    expect(utcTimestampSchema.safeParse("2026-08-09T12:34:56Z").success).toBe(false);
    expect(utcTimestampSchema.safeParse("2026-08-09T12:34:56.7Z").success).toBe(false);
    expect(utcTimestampSchema.safeParse("2026-08-09T12:34:56.7890Z").success).toBe(false);
  });

  it("passes one AbortSignal unchanged from Application to model, tool and subprocess", async () => {
    const controller = new AbortController();
    const application = createApplication();
    const applicationContext = application.cancellationContext(controller.signal);
    let modelSignal: AbortSignal | null = null;
    let toolSignal: AbortSignal | null = null;
    let subprocessSignal: AbortSignal | null = null;
    const model: ModelAdapter = {
      provider: "test",
      model: "test-model",
      capabilities: () => ({
        protocolVersion: "model-adapter:v1",
        streaming: false,
        toolCalling: true,
        parallelToolCalls: true,
        reasoningContinuation: false,
        serverSideTools: false,
      }),
      generate: async (request) => {
        modelSignal = request.signal;
        return {
          responseId: "response-1",
          model: "test-model",
          outputText: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            totalTokens: 2,
            costUsd: 0,
            durationMs: 1,
            providerUsage: {},
          },
        };
      },
    };
    application.toolRegistry.register({
      name: "cancellation_probe",
      version: "tool:cancellation_probe@test",
      normalizationVersion: "normalization:test-v1",
      description: "Observe cancellation propagation",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({}),
      outputSchema: z.object({ observed: z.boolean() }),
      availability: {
        available: true,
        reasonCode: null,
        message: null,
        checkedAt: "2026-08-09T00:00:00.000Z",
      },
      normalizeInput: (input) => ({ effectiveInput: input, transformations: [] }),
      claimResources: () => [{ key: "workspace:cancellation", mode: "read", scope: "workspace" }],
      execute: async (_input, context) => {
        toolSignal = context.signal;
        const subprocessContext: CancellationContext = context;
        subprocessSignal = subprocessContext.signal;
        return { observed: true };
      },
    });

    await model.generate({ input: "inspect", ...applicationContext });
    await application.toolRuntime.execute({
      toolName: "cancellation_probe",
      input: {},
      workspace: process.cwd(),
      codeVersion: null,
      diffHash: null,
      configVersion: "config:v1",
      sessionId: createStableId(),
      taskId: createStableId(),
      workspaceId: createStableId(),
      authorizationVersion: "authorization:test-v1",
      taskAuthorization: null,
      approvalToken: null,
      ...applicationContext,
    });

    expect(modelSignal).toBe(controller.signal);
    expect(toolSignal).toBe(controller.signal);
    expect(subprocessSignal).toBe(controller.signal);

    controller.abort();
    expect(cancellationFailure(applicationContext)).toMatchObject({ category: "cancelled" });
  });

  it("reports an expired deadline without replacing the caller signal", () => {
    const controller = new AbortController();
    const context = createCancellationContext(
      controller.signal,
      createUtcTimestamp(new Date("2026-08-09T00:00:00.000Z")),
    );

    expect(context.signal).toBe(controller.signal);
    expect(cancellationFailure(context, new Date("2026-08-09T00:00:00.001Z"))).toMatchObject({
      category: "deadline_exceeded",
    });
  });
});
