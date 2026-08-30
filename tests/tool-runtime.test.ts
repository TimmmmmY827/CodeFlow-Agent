import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../src/events/agent-event.js";
import type { ExecutionJournal, FinishExecutionInput } from "../src/events/execution-journal.js";
import { PermissionEngine } from "../src/policy/permission-engine.js";
import { createLegacyOperationHash } from "../src/policy/operation-hash.js";
import { canonicalJson } from "../src/shared/json.js";
import type { ArtifactWriter } from "../src/storage/storage.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime, type ToolExecutionRequest } from "../src/tools/tool-runtime.js";
import { ToolExecutionError, type ToolDefinition } from "../src/tools/tool.js";

describe("ToolRuntime", () => {
  it("normalizes effective input before hashing, resource claims, and execution", async () => {
    const registry = new ToolRegistry();
    let executedPath = "";
    registerTool(registry, {
      name: "read_file",
      description: "Read",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({ path: z.string() }),
      normalizeInput: (input) => ({
        effectiveInput: { path: input.path.trim() },
        transformations: [{
          field: "/path",
          ruleCode: "trim_whitespace",
          beforeHash: digest(input.path),
          afterHash: digest(input.path.trim()),
        }],
      }),
      claimResources: (input) => [{ key: `path:${input.path}`, mode: "read", scope: "path" }],
      execute: async ({ path }) => { executedPath = path; return { ok: true }; },
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine());

    const result = await runtime.execute(request("read_file", { path: " README.md " }));

    expect(executedPath).toBe("README.md");
    expect(result.operationHash).toBe(createLegacyOperationHash({
      toolName: "read_file",
      input: { path: "README.md" },
      codeVersion: "git:abc123",
    }));
  });

  it("rejects forged, duplicate, missing, and incomplete transformation evidence", async () => {
    const cases = [
      [{ field: "/path", ruleCode: "trim_whitespace", beforeHash: digest("forged"), afterHash: digest("README.md") }],
      [
        { field: "/path", ruleCode: "trim_whitespace", beforeHash: digest(" README.md "), afterHash: digest("README.md") },
        { field: "/path", ruleCode: "duplicate", beforeHash: digest(" README.md "), afterHash: digest("README.md") },
      ],
      [{ field: "/missing", ruleCode: "wrong_field", beforeHash: digest(" README.md "), afterHash: digest("README.md") }],
      [],
    ] as const;

    for (const [index, transformations] of cases.entries()) {
      const registry = new ToolRegistry();
      let executions = 0;
      registerTool(registry, {
        name: `forged_transform_${index}`,
        description: "Reject forged transformation evidence",
        risk: "automatic",
        sideEffect: "none",
        retryPolicy: "safe",
        inputSchema: z.object({ path: z.string() }),
        normalizeInput: () => ({ effectiveInput: { path: "README.md" }, transformations }),
        execute: async () => { executions += 1; return { ok: true }; },
      });

      await expect(new ToolRuntime(registry, new PermissionEngine()).execute(
        request(`forged_transform_${index}`, { path: " README.md " }),
      )).resolves.toMatchObject({
        status: "failed",
        error: { category: "input_transformation_invalid" },
      });
      expect(executions).toBe(0);
    }
  });

  it("rejects unavailable tools, invalid resource claims, and invalid output before reporting completion", async () => {
    const registry = new ToolRegistry();
    let unavailableExecutions = 0;
    registerTool(registry, {
      name: "missing_runtime",
      description: "Unavailable",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({}),
      availability: {
        available: false,
        reasonCode: "runtime_missing",
        message: "Runtime is unavailable.",
        checkedAt: "2026-08-15T00:00:00.000Z",
      },
      execute: async () => { unavailableExecutions += 1; return { ok: true }; },
    });
    registerTool(registry, {
      name: "invalid_claims",
      description: "Invalid claims",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({}),
      claimResources: () => [],
      execute: async () => ({ ok: true }),
    });
    registerTool(registry, {
      name: "invalid_output",
      description: "Invalid output",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }) as z.ZodType<unknown>,
      execute: async () => ({ ok: "not-a-boolean" }),
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine());

    await expect(runtime.execute(request("missing_runtime", {}))).resolves.toMatchObject({
      status: "failed",
      error: { category: "tool_unavailable" },
    });
    await expect(runtime.execute(request("invalid_claims", {}))).resolves.toMatchObject({
      status: "failed",
      error: { category: "resource_claim_invalid" },
    });
    await expect(runtime.execute(request("invalid_output", {}))).resolves.toMatchObject({
      status: "failed",
      error: { category: "invalid_tool_output" },
    });
    expect(unavailableExecutions).toBe(0);
  });

  it("settles a durable start without executing when cancellation wins the commit fence", async () => {
    const controller = new AbortController();
    let executions = 0;
    const finishes: FinishExecutionInput[] = [];
    let beginPayload: unknown;
    const journal: ExecutionJournal = {
      append: async () => ({} as AgentEvent),
      begin: async (input) => {
        beginPayload = input.payload;
        controller.abort();
        return {
          operationId: randomUUID(),
          reservationId: randomUUID(),
          spanId: randomUUID(),
          identity: input.identity,
          kind: input.kind,
          name: input.name,
          operationHash: input.operationHash,
          startedAt: "2026-08-15T00:00:00.000Z",
        };
      },
      finish: async (input) => {
        finishes.push(input);
        return {} as AgentEvent;
      },
    };
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: "read_file",
      description: "Read",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({ maxBytes: z.number().int().default(10) }),
      execute: async () => { executions += 1; return { ok: true }; },
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine(), { journal });

    const result = await runtime.execute({
      ...request("read_file", {}),
      signal: controller.signal,
      traceId: randomUUID(),
    });

    expect(result).toMatchObject({ status: "cancelled", sideEffectStatus: "none" });
    expect(executions).toBe(0);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ status: "cancelled", actual: { toolCalls: 0 } });
    expect(beginPayload).toMatchObject({
      toolName: "read_file",
      toolContract: {
        name: "read_file",
        version: "tool:read_file@test",
        inputSchemaHash: expect.stringMatching(/^sha256:/),
        outputSchemaHash: expect.stringMatching(/^sha256:/),
        normalizationVersion: "normalization:test-v1",
      },
      requestedInputHash: expect.stringMatching(/^sha256:/),
      effectiveInputHash: expect.stringMatching(/^sha256:/),
      transformations: [{
        field: "$",
        ruleCode: "schema_parse_v1",
        beforeHash: expect.stringMatching(/^sha256:/),
        afterHash: expect.stringMatching(/^sha256:/),
      }],
      resourceClaims: [{ key: "workspace:test", mode: "read", scope: "workspace" }],
    });
  });

  it("isolates non-authoritative observer failures", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: "read_file",
      description: "Read",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine(), {
      observe: () => { throw new Error("observer unavailable"); },
    });

    await expect(runtime.execute(request("read_file", {}))).resolves.toMatchObject({ status: "completed" });
  });

  it("preserves stable provider failure categories", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: "bounded_read",
      description: "Reject an unsafe read",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({}),
      execute: async () => {
        throw new ToolExecutionError({
          category: "workspace_boundary_violation",
          message: "The requested path escapes the workspace.",
          retryable: false,
          sideEffectStatus: "none",
          recovery: null,
        });
      },
    });

    const result = await new ToolRuntime(registry, new PermissionEngine()).execute(request("bounded_read", {}));

    expect(result).toMatchObject({
      status: "failed",
      error: { category: "workspace_boundary_violation", sideEffectStatus: "none" },
    });
  });

  it("validates input and returns a uniform result envelope", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: "read_file",
      description: "Read one file",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => ({ path, content: "hello" }),
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine());

    const invalid = await runtime.execute(request("read_file", { path: "" }));
    const completed = await runtime.execute(request("read_file", { path: "README.md" }));

    expect(invalid).toMatchObject({ status: "failed", error: { category: "invalid_input" } });
    expect(completed).toMatchObject({
      status: "completed",
      output: { path: "README.md", content: "hello" },
      artifact: null,
      error: null,
    });
  });

  it("rejects parsed tool values that cannot cross the JSON boundary", async () => {
    const registry = new ToolRegistry();
    expect(() => registerTool(registry, {
      name: "invalid_contract_tool",
      description: "Expose a non-JSON tool contract",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({ requestedAt: z.date() }),
      execute: async () => ({ ok: true }),
    })).toThrow("input schema");
  });

  it("binds a confirmation to canonical input and code version", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: "commit_push_create_pr",
      description: "Publish approved changes",
      risk: "single_confirmation",
      sideEffect: "external_write",
      retryPolicy: "reconcile",
      inputSchema: z.object({ branch: z.string(), remote: z.string() }),
      execute: async () => ({ published: true }),
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine());
    const input = { remote: "origin", branch: "agent/demo" };
    const operationHash = createLegacyOperationHash({
      toolName: "commit_push_create_pr",
      input,
      codeVersion: "git:abc123",
    });

    const result = await runtime.execute({
      ...request("commit_push_create_pr", input),
      approvalToken: {
        approvalId: "approval-1",
        toolName: "commit_push_create_pr",
        operationHash,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.operationHash).toBe(operationHash);

    const replay = await runtime.execute({
      ...request("commit_push_create_pr", input),
      approvalToken: {
        approvalId: "approval-1",
        toolName: "commit_push_create_pr",
        operationHash,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
    expect(replay).toMatchObject({
      status: "denied",
      error: { category: "approval_already_consumed" },
    });
  });

  it("externalizes long output through ArtifactStore", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: "run_command",
      description: "Run an authorized command",
      risk: "task_authorized",
      sideEffect: "workspace_write",
      retryPolicy: "never",
      inputSchema: z.object({ command: z.string() }),
      execute: async () => ({ stdout: "x".repeat(200) }),
    });
    const artifactStore: ArtifactWriter = {
      write: async (_sessionId, mediaType, content, sensitivity) => ({
        artifactId: "artifact-1",
        relativePath: "session/output.json",
        mediaType,
        byteLength: content.byteLength,
        sha256: `sha256:${"a".repeat(64)}`,
        sensitivity,
      }),
    };
    const runtime = new ToolRuntime(registry, new PermissionEngine(), {
      artifactStore,
      maxInlineBytes: 16,
    });

    const result = await runtime.execute(request("run_command", { command: "test" }));

    expect(result).toMatchObject({
      status: "completed",
      sideEffectStatus: "applied",
      output: null,
      artifact: { artifactId: "artifact-1" },
    });
  });

  it("marks an external write failure unknown instead of retrying blindly", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, {
      name: "commit_push_create_pr",
      description: "Publish approved changes",
      risk: "single_confirmation",
      sideEffect: "external_write",
      retryPolicy: "reconcile",
      inputSchema: z.object({ branch: z.string() }),
      execute: async () => {
        throw new Error("connection dropped after push");
      },
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine());
    const input = { branch: "agent/demo" };
    const operationHash = createLegacyOperationHash({
      toolName: "commit_push_create_pr",
      input,
      codeVersion: "git:abc123",
    });

    const result = await runtime.execute({
      ...request("commit_push_create_pr", input),
      approvalToken: {
        approvalId: "approval-external",
        toolName: "commit_push_create_pr",
        operationHash,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      status: "unknown",
      sideEffectStatus: "unknown",
      error: { category: "side_effect_unknown", retryable: false },
    });
  });
});

function request(toolName: string, input: unknown): ToolExecutionRequest {
  return {
    toolName,
    input,
    workspace: "C:/workspace",
    codeVersion: "git:abc123",
    configVersion: "config:v1",
    signal: new AbortController().signal,
    sessionId: randomUUID(),
    taskId: randomUUID(),
    taskWriteAuthorized: true,
    approvalToken: null,
  };
}

type TestTool<TInput, TOutput> = Pick<
  ToolDefinition<TInput, TOutput>,
  "name" | "description" | "risk" | "sideEffect" | "retryPolicy" | "inputSchema" | "execute"
> & {
  readonly outputSchema?: z.ZodType<TOutput>;
  readonly availability?: ToolDefinition<TInput, TOutput>["availability"];
  readonly normalizeInput?: ToolDefinition<TInput, TOutput>["normalizeInput"];
  readonly claimResources?: ToolDefinition<TInput, TOutput>["claimResources"];
};

function registerTool<TInput, TOutput>(registry: ToolRegistry, tool: TestTool<TInput, TOutput>): void {
  const { outputSchema, availability, normalizeInput, claimResources, ...definition } = tool;
  registry.register({
    ...definition,
    version: `tool:${tool.name}@test`,
    normalizationVersion: "normalization:test-v1",
    outputSchema: outputSchema ?? z.unknown() as z.ZodType<TOutput>,
    availability: availability ?? {
      available: true,
      reasonCode: null,
      message: null,
      checkedAt: "2026-08-15T00:00:00.000Z",
    },
    normalizeInput: normalizeInput ?? ((input) => ({ effectiveInput: input, transformations: [] })),
    claimResources: claimResources ?? (() => [{
      key: "workspace:test",
      mode: tool.sideEffect === "none" ? "read" : "write",
      scope: "workspace",
    }]),
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
