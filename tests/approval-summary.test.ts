import { describe, expect, it } from "vitest";

import { createApprovalSummary } from "../src/policy/approval-summary.js";
import { binding } from "./fixtures/permission.js";

describe("createApprovalSummary", () => {
  it("contains only reviewed display facts and rejects credential-shaped remote URLs", () => {
    const operation = binding();
    const summary = createApprovalSummary({
      binding: operation,
      resources: [
        { kind: "remote", value: "origin" },
        { kind: "branch", value: "codex/c03-permission-engine" },
        { kind: "path", value: "C:/workspace/src/policy" },
      ],
      expiresAt: "2026-08-15T10:05:00.000Z",
    });

    expect(summary).toEqual({
      schemaVersion: 1,
      toolName: operation.toolName,
      toolVersion: operation.toolVersion,
      resources: expect.any(Array),
      codeVersion: operation.codeVersion,
      diffHash: operation.diffHash,
      expiresAt: "2026-08-15T10:05:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("input");
    expect(() => createApprovalSummary({
      binding: operation,
      resources: [{ kind: "remote", value: "https://token@example.invalid/repo" }],
      expiresAt: "2026-08-15T10:05:00.000Z",
    })).toThrow(/remote name/i);
  });
});
