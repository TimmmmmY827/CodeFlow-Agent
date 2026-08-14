import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CompletionGate, type CompletionClaim } from "../src/completion/completion-gate.js";
import { createFinishTaskTool } from "../src/tools/builtin/finish-task.js";

describe("CompletionGate", () => {
  it("verifies a claim only when code, diff, evidence, trace and safety checks agree", () => {
    const claim = validClaim();
    const result = new CompletionGate().evaluate(claim, {
      codeVersion: claim.codeVersion,
      diffHash: claim.diffHash,
    });

    expect(result).toEqual({ outcome: "verified", reasons: [] });
  });

  it("rejects stale, unsafe or unverified completion claims", () => {
    const claim: CompletionClaim = {
      ...validClaim(),
      traceComplete: false,
      safetyVetoes: [
        {
          code: "unapproved_external_write",
          description: "unapproved external write",
          eventId: randomUUID(),
          artifact: null,
        },
      ],
      unverifiedItems: [{ description: "hidden tests", blocking: true }],
    };
    const result = new CompletionGate().evaluate(claim, {
      codeVersion: "git:newer",
      diffHash: claim.diffHash,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "code version changed after the claim",
        "critical trace is incomplete",
        "safety veto [unapproved_external_write]: unapproved external write",
        "blocking item is unverified: hidden tests",
      ]),
    );
  });

  it("rejects a safety veto that has no auditable fact reference", () => {
    const claim = {
      ...validClaim(),
      safetyVetoes: [
        {
          code: "unapproved_external_write",
          description: "unapproved external write",
          eventId: null,
          artifact: null,
        },
      ],
    };

    const result = new CompletionGate().evaluate(claim, {
      codeVersion: claim.codeVersion,
      diffHash: claim.diffHash,
    });

    expect(result).toMatchObject({
      outcome: "rejected",
      reasons: [expect.stringContaining("must reference an event or Artifact")],
    });
  });

  it("exposes the gate through the finish_task tool contract", async () => {
    const claim = validClaim();
    const tool = createFinishTaskTool({
      capture: async () => ({ codeVersion: claim.codeVersion, diffHash: claim.diffHash }),
    });

    const result = await tool.execute(claim, {
      workspace: "C:/workspace",
      codeVersion: claim.codeVersion,
      diffHash: claim.diffHash,
      configVersion: "config:v1",
      signal: new AbortController().signal,
      deadlineAt: null,
      sessionId: "session-1",
      taskId: "task-1",
    });

    expect(tool).toMatchObject({ name: "finish_task", risk: "control", sideEffect: "none" });
    expect(result).toEqual({ outcome: "verified", reasons: [] });
  });
});

function validClaim(): CompletionClaim {
  return {
    codeVersion: "git:abc123",
    diffHash: "sha256:diff",
    traceComplete: true,
    verification: [
      {
        name: "unit tests",
        required: true,
        status: "passed",
        evidence: "artifact:test-log",
      },
    ],
    unverifiedItems: [],
    safetyVetoes: [],
  };
}
