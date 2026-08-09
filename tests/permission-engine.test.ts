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
          toolName: "commit_push_create_pr",
          operationHash: "old-hash",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      },
    );

    expect(decision.outcome).toBe("deny");
  });
});

function tool(name: string, risk: ToolRisk): ToolDefinition<Record<string, never>, void> {
  return {
    name,
    risk,
    description: name,
    inputSchema: z.object({}),
    execute: async () => undefined,
  };
}
