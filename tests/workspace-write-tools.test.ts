import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../src/events/agent-event.js";
import type { ExecutionJournal } from "../src/events/execution-journal.js";
import { PermissionEngine } from "../src/policy/permission-engine.js";
import type { JsonObject } from "../src/shared/json.js";
import { registerWorkspaceWriteTools } from "../src/tools/builtin/workspace-write-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime, type ToolExecutionRequest } from "../src/tools/tool-runtime.js";

describe("workspace write tools", () => {
  let workspace: string;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "codeflow-write-tools-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "README.md"), "# Fixture\n", "utf8");
    await writeFile(join(workspace, "src", "existing.ts"), "export const value = 1;\n", "utf8");
    git(workspace, "init");
    git(workspace, "config", "user.name", "CodeFlow Test");
    git(workspace, "config", "user.email", "codeflow@example.invalid");
    git(workspace, "add", ".");
    git(workspace, "commit", "-m", "initial fixture");
    const registry = new ToolRegistry();
    registerWorkspaceWriteTools(registry);
    runtime = new ToolRuntime(registry, new PermissionEngine(), { journal: journalStub() });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("creates and replaces files atomically with compare-and-swap evidence", async () => {
    const created = await runtime.execute(await request(workspace, "write_file", {
      path: "src/created.ts",
      content: "export const created = true;\n",
      mode: "create",
      expectedSha256: null,
    }));
    expect(created).toMatchObject({
      status: "completed",
      sideEffectStatus: "applied",
      output: { path: "src/created.ts", beforeSha256: null },
    });

    const beforeSha256 = digest(await readFile(join(workspace, "src", "existing.ts")));
    const replaced = await runtime.execute(await request(workspace, "write_file", {
      path: "src/existing.ts",
      content: "export const value = 2;\n",
      mode: "replace",
      expectedSha256: beforeSha256,
    }));
    expect(replaced).toMatchObject({
      status: "completed",
      sideEffectStatus: "applied",
      output: { path: "src/existing.ts", beforeSha256 },
    });
    await expect(readFile(join(workspace, "src", "existing.ts"), "utf8"))
      .resolves.toBe("export const value = 2;\n");
  });

  it("rejects stale file versions before changing bytes", async () => {
    const original = await readFile(join(workspace, "src", "existing.ts"), "utf8");
    const result = await runtime.execute(await request(workspace, "write_file", {
      path: "src/existing.ts",
      content: "overwritten\n",
      mode: "replace",
      expectedSha256: `sha256:${"0".repeat(64)}`,
    }));

    expect(result).toMatchObject({
      status: "failed",
      sideEffectStatus: "not_started",
      error: { category: "file_version_conflict", retryable: true },
    });
    await expect(readFile(join(workspace, "src", "existing.ts"), "utf8")).resolves.toBe(original);
  });

  it("blocks traversal, reserved directories, and link traversal", async () => {
    const traversal = await runtime.execute(await request(workspace, "write_file", {
      path: "../outside.txt",
      content: "outside",
      mode: "create",
      expectedSha256: null,
    }));
    const reserved = await runtime.execute(await request(workspace, "write_file", {
      path: ".git/config",
      content: "unsafe",
      mode: "replace",
      expectedSha256: digest(Buffer.from("irrelevant")),
    }));

    expect(traversal).toMatchObject({ status: "failed", error: { category: "workspace_boundary_violation" } });
    expect(reserved).toMatchObject({ status: "failed", error: { category: "path_ignored" } });

    const realDirectory = join(workspace, "real-directory");
    await mkdir(realDirectory);
    await symlink(realDirectory, join(workspace, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
    const linked = await runtime.execute(await request(workspace, "write_file", {
      path: "linked-directory/created.txt",
      content: "unsafe",
      mode: "create",
      expectedSha256: null,
    }));
    expect(linked).toMatchObject({ status: "failed", error: { category: "workspace_link_rejected" } });
  });

  it("applies a multi-file patch only after Git and file versions match", async () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-# Fixture",
      "+# Changed",
      "diff --git a/src/created.ts b/src/created.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/created.ts",
      "@@ -0,0 +1 @@",
      "+export const created = true;",
      "",
    ].join("\n");
    const result = await runtime.execute(await request(workspace, "apply_patch", {
      patch,
      expectedCodeVersion: codeVersion(workspace),
      expectedFiles: [
        { path: "README.md", sha256: digest(await readFile(join(workspace, "README.md"))) },
        { path: "src/created.ts", sha256: null },
      ],
    }));

    expect(result).toMatchObject({
      status: "completed",
      sideEffectStatus: "applied",
      output: {
        changedFiles: [
          { path: "README.md", kind: "modified" },
          { path: "src/created.ts", kind: "created" },
        ],
      },
    });
    expect((result.output as JsonObject | null)?.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect((await readFile(join(workspace, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("# Changed\n");
  });

  it("does not partially apply a patch when any hunk is invalid", async () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-# Fixture",
      "+# Changed",
      "diff --git a/src/existing.ts b/src/existing.ts",
      "--- a/src/existing.ts",
      "+++ b/src/existing.ts",
      "@@ -1 +1 @@",
      "-this line does not exist",
      "+export const value = 2;",
      "",
    ].join("\n");
    const result = await runtime.execute(await request(workspace, "apply_patch", {
      patch,
      expectedCodeVersion: codeVersion(workspace),
      expectedFiles: [
        { path: "README.md", sha256: digest(await readFile(join(workspace, "README.md"))) },
        { path: "src/existing.ts", sha256: digest(await readFile(join(workspace, "src", "existing.ts"))) },
      ],
    }));

    expect(result).toMatchObject({
      status: "failed",
      sideEffectStatus: "not_started",
      error: { category: "patch_check_failed" },
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe("# Fixture\n");
  });

  it("requires matching task authorization before a write tool starts", async () => {
    const executionRequest = await request(workspace, "write_file", {
      path: "unauthorized.txt",
      content: "blocked",
      mode: "create",
      expectedSha256: null,
    });
    const result = await runtime.execute({ ...executionRequest, taskAuthorization: null });

    expect(result).toMatchObject({
      status: "approval_required",
      sideEffectStatus: "not_started",
      error: { category: "task_authorization_required" },
    });
    await expect(readFile(join(workspace, "unauthorized.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs allowlisted commands without forwarding secrets or invoking a shell", async () => {
    await writeFile(join(workspace, "command.cjs"), [
      "const fs = require('node:fs');",
      "fs.writeFileSync('command-output.txt', process.env.DEEPSEEK_API_KEY ?? 'absent');",
      "console.log('command completed');",
      "",
    ].join("\n"), "utf8");
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-secret-must-not-reach-child";
    try {
      const result = await runtime.execute(await request(workspace, "run_command", {
        executable: "node",
        args: ["command.cjs"],
        purpose: "Exercise the bounded command provider.",
      }));
      expect(result).toMatchObject({
        status: "completed",
        sideEffectStatus: "applied",
        output: { exitCode: 0, stdout: "command completed\n", timedOut: false },
      });
      await expect(readFile(join(workspace, "command-output.txt"), "utf8")).resolves.toBe("absent");
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }

    const denied = await runtime.execute(await request(workspace, "run_command", {
      executable: "node",
      args: ["-e", "require('node:fs').writeFileSync('shell-bypass.txt', 'unsafe')"],
      purpose: "This inline command must be denied.",
    }));
    expect(denied).toMatchObject({ status: "failed", error: { category: "command_argument_denied" } });
    await expect(readFile(join(workspace, "shell-bypass.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await rm(join(workspace, "command-output.txt"));
    const externalPath = await runtime.execute(await request(workspace, "run_command", {
      executable: "node",
      args: ["command.cjs", "../outside.txt"],
      purpose: "An explicit workspace escape must be denied before execution.",
    }));
    const gitCommand = await runtime.execute(await request(workspace, "run_command", {
      executable: "git",
      args: ["status"],
      purpose: "Git access must use the workspace-scoped built-in tools.",
    }));
    expect(externalPath).toMatchObject({ status: "failed", error: { category: "command_argument_denied" } });
    expect(gitCommand).toMatchObject({ status: "failed", error: { category: "command_executable_denied" } });
    await expect(readFile(join(workspace, "command-output.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates a timed-out command tree and reports unknown side-effect state", async () => {
    await writeFile(join(workspace, "slow-command.cjs"), [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"setTimeout(() => require('node:fs').writeFileSync('late-marker.txt', 'unsafe'), 800)\"], { stdio: 'ignore' });",
      "child.unref();",
      "setTimeout(() => {}, 10000);",
      "",
    ].join("\n"), "utf8");
    const result = await runtime.execute(await request(workspace, "run_command", {
      executable: "node",
      args: ["slow-command.cjs"],
      timeoutMs: 150,
      purpose: "Verify timeout process-tree cleanup.",
    }));

    expect(result).toMatchObject({
      status: "unknown",
      sideEffectStatus: "unknown",
      error: { category: "command_timeout", retryable: false },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
    await expect(readFile(join(workspace, "late-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);
});

async function request(workspace: string, toolName: string, input: unknown): Promise<ToolExecutionRequest> {
  const sessionId = randomUUID();
  const taskId = randomUUID();
  const workspaceId = randomUUID();
  return {
    toolName,
    input,
    workspace,
    codeVersion: codeVersion(workspace),
    diffHash: `sha256:${"d".repeat(64)}`,
    configVersion: "config:test",
    signal: new AbortController().signal,
    sessionId,
    taskId,
    workspaceId,
    authorizationVersion: "authorization:test-v1",
    traceId: randomUUID(),
    taskAuthorization: {
      schemaVersion: 1,
      authorizationId: randomUUID(),
      authorizationVersion: "authorization:test-v1",
      sessionId,
      taskId,
      workspaceId,
      state: "active",
      grantedAt: "2026-08-15T00:00:00.000Z",
      expiresAt: null,
    },
    approvalToken: null,
  };
}

function journalStub(): ExecutionJournal {
  return {
    append: async () => ({} as AgentEvent),
    begin: async (input) => ({
      operationId: randomUUID(),
      reservationId: randomUUID(),
      spanId: randomUUID(),
      identity: input.identity,
      kind: input.kind,
      name: input.name,
      operationHash: input.operationHash,
      authorization: input.authorization ?? null,
      startedAt: "2026-08-15T00:00:00.000Z",
    }),
    finish: async () => ({} as AgentEvent),
  };
}

function codeVersion(workspace: string): string {
  return `git:${git(workspace, "rev-parse", "--verify", "HEAD").trim()}`;
}

function git(workspace: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
