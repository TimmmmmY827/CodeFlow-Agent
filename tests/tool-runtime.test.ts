import { randomUUID } from "node:crypto";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { PermissionEngine } from "../src/policy/permission-engine.js";
import { createOperationHash } from "../src/policy/operation-hash.js";
import type { ArtifactStore } from "../src/storage/storage.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime, type ToolExecutionRequest } from "../src/tools/tool-runtime.js";

describe("ToolRuntime", () => {
  it("validates input and returns a uniform result envelope", async () => {
    const registry = new ToolRegistry();
    registry.register({
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
    registry.register({
      name: "invalid_contract_tool",
      description: "Expose a non-JSON tool contract",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({ requestedAt: z.date() }),
      execute: async () => ({ ok: true }),
    });
    const runtime = new ToolRuntime(registry, new PermissionEngine());

    const result = await runtime.execute(
      request("invalid_contract_tool", { requestedAt: new Date("2026-08-09T00:00:00.000Z") }),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { category: "not_json_serializable", retryable: false },
    });
  });

  it("binds a confirmation to canonical input and code version", async () => {
    const registry = new ToolRegistry();
    registry.register({
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
    const operationHash = createOperationHash({
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
    registry.register({
      name: "run_command",
      description: "Run an authorized command",
      risk: "task_authorized",
      sideEffect: "workspace_write",
      retryPolicy: "never",
      inputSchema: z.object({ command: z.string() }),
      execute: async () => ({ stdout: "x".repeat(200) }),
    });
    const artifactStore: ArtifactStore = {
      write: async (_sessionId, mediaType, content, sensitivity) => ({
        artifactId: "artifact-1",
        relativePath: "session/output.json",
        mediaType,
        byteLength: content.byteLength,
        sha256: "sha256:test",
        sensitivity,
      }),
      deleteSessionArtifacts: async () => undefined,
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
    registry.register({
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
    const operationHash = createOperationHash({
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
