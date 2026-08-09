import { z } from "zod";
import { describe, expect, it } from "vitest";

import { PermissionEngine } from "../src/policy/permission-engine.js";
import type { ToolDefinition, ToolRisk } from "../src/tools/tool.js";

describe("PermissionEngine", () => {
  it("allows fixed automatic tools", () => {
    const decision = new PermissionEngine().decide(tool("read_file", "automatic"), {
      taskWriteAuthorized: false,
      operationHash: null,
      approvalToken: null,
    });

    expect(decision.outcome).toBe("allow");
  });

  it("requires task authorization for workspace writes", () => {
    const decision = new PermissionEngine().decide(tool("apply_patch", "task_authorized"), {
      taskWriteAuthorized: false,
      operationHash: null,
      approvalToken: null,
    });

    expect(decision.outcome).toBe("confirm");
  });

  it("rejects an approval bound to different operation parameters", () => {
    const decision = new PermissionEngine().decide(
      tool("commit_push_create_pr", "single_confirmation"),
      {
        taskWriteAuthorized: true,
        operationHash: "current-hash",
        approvalToken: {
          approvalId: "approval-1",
          toolName: "commit_push_create_pr",
          operationHash: "old-hash",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      },
    );

    expect(decision.outcome).toBe("deny");
  });

  it("rejects an approval with an invalid expiration", () => {
    const decision = new PermissionEngine().decide(
      tool("commit_push_create_pr", "single_confirmation"),
      {
        taskWriteAuthorized: true,
        operationHash: "operation-hash",
        approvalToken: {
          approvalId: "approval-2",
          toolName: "commit_push_create_pr",
          operationHash: "operation-hash",
          expiresAt: "not-a-date",
        },
      },
    );

    expect(decision.outcome).toBe("deny");
  });

  it("denies an unregistered risk class at the runtime boundary", () => {
    const untrustedTool = {
      name: "repository_supplied_tool",
      risk: "repository_defined",
    } as unknown as Parameters<PermissionEngine["decide"]>[0];

    const decision = new PermissionEngine().decide(untrustedTool, {
      taskWriteAuthorized: true,
      operationHash: null,
      approvalToken: null,
    });

    expect(decision).toEqual({
      outcome: "deny",
      reason: "The tool risk class is not registered.",
    });
  });
});

function tool(name: string, risk: ToolRisk): ToolDefinition<Record<string, never>, void> {
  return {
    name,
    risk,
    sideEffect: "none",
    retryPolicy: "safe",
    description: name,
    inputSchema: z.object({}),
    execute: async () => undefined,
  };
}
