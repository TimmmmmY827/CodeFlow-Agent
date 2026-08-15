import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PermissionEngine } from "../src/policy/permission-engine.js";
import type { JsonObject } from "../src/shared/json.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime, type ToolExecutionRequest } from "../src/tools/tool-runtime.js";
import { registerWorkspaceReadTools } from "../src/tools/builtin/workspace-read-tools.js";

describe("workspace read tools", () => {
  let workspace: string;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "codeflow-read-tools-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "hello.ts"), "export const greeting = '你好';\r\nexport const answer = 42;\r\n", "utf8");
    await writeFile(join(workspace, "README.md"), "# Fixture\n", "utf8");
    await mkdir(join(workspace, "node_modules"));
    await writeFile(join(workspace, "node_modules", "ignored.js"), "secret", "utf8");
    const registry = new ToolRegistry();
    registerWorkspaceReadTools(registry);
    runtime = new ToolRuntime(registry, new PermissionEngine());
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("lists stable bounded entries without ignored directories", async () => {
    const result = await runtime.execute(request(workspace, "list_files", { maxDepth: 2, maxEntries: 20 }));

    expect(result.status).toBe("completed");
    expect(result.output).toMatchObject({ truncated: false, skippedLinks: 0 });
    expect((result.output as JsonObject | null)?.entries ?? null).toEqual([
      { path: "README.md", type: "file", size: 10 },
      { path: "src/", type: "directory", size: null },
      { path: "src/hello.ts", type: "file", size: 62 },
    ]);
  });

  it("reads UTF-8 lines with immutable content evidence", async () => {
    const result = await runtime.execute(request(workspace, "read_file", {
      path: "src/hello.ts",
      startLine: 2,
      endLine: 2,
    }));

    expect(result).toMatchObject({
      status: "completed",
      output: {
        path: "src/hello.ts",
        content: "export const answer = 42;",
        startLine: 2,
        endLine: 2,
        truncated: true,
      },
    });
    expect((result.output as JsonObject | null)?.sha256 ?? "").toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("searches text with structured bounded matches", async () => {
    const result = await runtime.execute(request(workspace, "search_text", {
      query: "answer",
      path: "src",
      maxMatches: 10,
    }));

    expect(result).toMatchObject({
      status: "completed",
      output: {
        truncated: false,
        matches: [{ path: "src/hello.ts", line: 2, column: 14, text: "export const answer = 42;" }],
      },
    });
  });

  it("rejects workspace traversal before reading", async () => {
    const result = await runtime.execute(request(workspace, "read_file", { path: "../outside.txt" }));

    expect(result).toMatchObject({
      status: "failed",
      sideEffectStatus: "none",
      error: { category: "workspace_boundary_violation", retryable: false },
    });
  });

  it("returns stable git status, diff and log records", async () => {
    git(workspace, "init");
    git(workspace, "config", "user.name", "CodeFlow Test");
    git(workspace, "config", "user.email", "codeflow@example.invalid");
    git(workspace, "add", ".");
    git(workspace, "commit", "-m", "initial fixture");
    await writeFile(join(workspace, "README.md"), "# Changed\n", "utf8");
    git(workspace, "mv", "src/hello.ts", "src/greeting.ts");

    const status = await runtime.execute(request(workspace, "git_status", {}));
    const diff = await runtime.execute(request(workspace, "git_diff", { scope: "working" }));
    const log = await runtime.execute(request(workspace, "git_log", { maxCount: 1 }));

    expect(status).toMatchObject({ status: "completed", output: { clean: false } });
    expect((status.output as JsonObject | null)?.entries).toEqual(expect.arrayContaining([
      { status: " M", path: "README.md" },
      { status: "R ", path: "src/greeting.ts", originalPath: "src/hello.ts" },
    ]));
    expect(diff).toMatchObject({ status: "completed", output: { scope: "working", truncated: false } });
    expect((diff.output as JsonObject | null)?.diff ?? "").toContain("+# Changed");
    expect(log).toMatchObject({ status: "completed" });
    const commits = (log.output as JsonObject | null)?.commits ?? [];
    expect(commits).toEqual([expect.objectContaining({ author: "CodeFlow Test", subject: "initial fixture" })]);
  });

  it("reports non-git workspaces without leaking provider errors", async () => {
    const result = await runtime.execute(request(workspace, "git_status", {}));

    expect(result).toMatchObject({ status: "failed", error: { category: "not_a_git_repository" } });
  });

  it("does not start a command after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.execute(request(workspace, "search_text", { query: "answer" }, controller.signal));

    expect(result).toMatchObject({ status: "cancelled", sideEffectStatus: "none", error: { category: "cancelled" } });
  });
});

function request(
  workspace: string,
  toolName: string,
  input: unknown,
  signal: AbortSignal = new AbortController().signal,
): ToolExecutionRequest {
  return {
    toolName,
    input,
    workspace,
    codeVersion: "git:test",
    configVersion: "config:test",
    signal,
    sessionId: randomUUID(),
    taskId: randomUUID(),
    taskWriteAuthorized: false,
    approvalToken: null,
  };
}

function git(workspace: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
}
