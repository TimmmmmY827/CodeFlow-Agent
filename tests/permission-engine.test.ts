import { describe, expect, it } from "vitest";

import { createApprovalSummary } from "../src/policy/approval-summary.js";
import { createOperationHash } from "../src/policy/operation-hash.js";
import {
  PERMISSION_SCHEMA_VERSION,
  type ApprovalRecord,
  type ApprovalToken,
  type TaskAuthorization,
} from "../src/policy/permission-contracts.js";
import { PermissionEngine, type PermissionSubject } from "../src/policy/permission-engine.js";
import type { Clock, ToolRisk } from "../src/shared/contracts.js";
import { binding } from "./fixtures/permission.js";

const NOW = "2026-08-15T10:00:00.000Z" as const;
const FUTURE = "2026-08-15T10:05:00.000Z" as const;
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const AUTHORIZATION_ID = "55555555-5555-4555-8555-555555555555";
const clock: Clock = { utcNow: () => NOW, monotonicNowMs: () => 0 };

describe("PermissionEngine", () => {
  it.each([
    ["automatic", "allow"],
    ["control", "allow"],
    ["task_authorized", "confirm"],
    ["single_confirmation", "confirm"],
  ] as const)("applies the fixed %s risk matrix", (risk, outcome) => {
    expect(new PermissionEngine(clock).evaluate(tool(risk), emptyContext()).outcome).toBe(outcome);
  });

  it("allows only an authorization bound to the same Session, Task, workspace, and version", () => {
    const operation = binding();
    const engine = new PermissionEngine(clock);
    const authorization = taskAuthorization();

    expect(engine.evaluate(tool("task_authorized"), {
      ...emptyContext(),
      binding: operation,
      taskAuthorization: authorization,
    }).outcome).toBe("allow");

    for (const changed of [
      { ...authorization, sessionId: "66666666-6666-4666-8666-666666666666" },
      { ...authorization, taskId: "66666666-6666-4666-8666-666666666666" },
      { ...authorization, workspaceId: "66666666-6666-4666-8666-666666666666" },
      { ...authorization, authorizationVersion: "authorization:v2" },
      { ...authorization, state: "revoked" as const },
    ]) {
      expect(engine.evaluate(tool("task_authorized"), {
        ...emptyContext(),
        binding: operation,
        taskAuthorization: changed,
      })).toMatchObject({ outcome: "deny", reasonCode: "task_authorization_invalid" });
    }
  });

  it("treats equality with the injected clock as expired", () => {
    const operation = binding();
    const record = approvalRecord({ expiresAt: NOW });
    const token = approvalToken(record);

    expect(new PermissionEngine(clock).evaluate(tool("single_confirmation"), {
      binding: operation,
      taskAuthorization: null,
      approvalToken: token,
      approvalRecord: record,
    })).toMatchObject({ outcome: "confirm", reasonCode: "approval_expired" });
  });

  it("allows matching approved evidence and denies every terminal non-expiry state", () => {
    const operation = binding();
    const engine = new PermissionEngine(clock);
    const approved = approvalRecord();

    expect(engine.evaluate(tool("single_confirmation"), {
      binding: operation,
      taskAuthorization: null,
      approvalToken: approvalToken(approved),
      approvalRecord: approved,
    }).outcome).toBe("allow");

    for (const state of ["denied", "consumed", "invalidated"] as const) {
      const record = approvalRecord({
        state,
        consumedAt: state === "consumed" ? NOW : null,
        decisionReason: `Approval is ${state}.`,
      });
      expect(engine.evaluate(tool("single_confirmation"), {
        binding: operation,
        taskAuthorization: null,
        approvalToken: approvalToken(record),
        approvalRecord: record,
      }).outcome).toBe("deny");
    }
  });

  it("denies malformed or mismatched approval evidence", () => {
    const operation = binding();
    const approved = approvalRecord();
    const invalidToken = { ...approvalToken(approved), operationHash: createOperationHash({
      ...operation,
      configVersion: "config:v2",
    }) };

    expect(new PermissionEngine(clock).evaluate(tool("single_confirmation"), {
      binding: operation,
      taskAuthorization: null,
      approvalToken: invalidToken,
      approvalRecord: approved,
    })).toMatchObject({ outcome: "deny", reasonCode: "approval_invalid" });

    expect(new PermissionEngine(clock).evaluate(
      { name: "delete_session", risk: "single_confirmation", sideEffect: "external_write" },
      {
        binding: operation,
        taskAuthorization: null,
        approvalToken: approvalToken(approved),
        approvalRecord: approved,
      },
    )).toMatchObject({ outcome: "deny", reasonCode: "approval_invalid" });

    expect(new PermissionEngine(clock).evaluate(tool("single_confirmation"), {
      binding: operation,
      taskAuthorization: null,
      approvalToken: { ...approvalToken(approved), expiresAt: "not-a-date" } as ApprovalToken,
      approvalRecord: approved,
    })).toMatchObject({ outcome: "deny", reasonCode: "approval_invalid" });
  });

  it("denies a repository-supplied risk class instead of treating text as policy", () => {
    const untrusted = {
      name: "repository_tool",
      risk: "repository_defined",
      sideEffect: "external_write",
    } as unknown as PermissionSubject;

    expect(new PermissionEngine(clock).evaluate(untrusted, emptyContext())).toEqual({
      outcome: "deny",
      reasonCode: "policy_metadata_invalid",
      reason: "The tool policy metadata is not registered.",
      authorizationId: null,
      approvalId: null,
    });
  });

  it("fails closed when trusted risk and side-effect metadata disagree", () => {
    expect(new PermissionEngine(clock).evaluate({
      name: "misclassified_publish",
      risk: "automatic",
      sideEffect: "external_write",
    }, emptyContext())).toMatchObject({
      outcome: "deny",
      reasonCode: "policy_metadata_invalid",
    });
  });
});

function tool(risk: ToolRisk): PermissionSubject {
  return {
    name: "commit_push_create_pr",
    risk,
    sideEffect: risk === "task_authorized"
      ? "workspace_write"
      : risk === "single_confirmation"
        ? "external_write"
        : "none",
  };
}

function emptyContext() {
  return {
    binding: null,
    taskAuthorization: null,
    approvalToken: null,
    approvalRecord: null,
  } as const;
}

function taskAuthorization(): TaskAuthorization {
  const operation = binding();
  return {
    schemaVersion: PERMISSION_SCHEMA_VERSION,
    authorizationId: AUTHORIZATION_ID,
    authorizationVersion: operation.authorizationVersion,
    sessionId: operation.sessionId,
    taskId: operation.taskId,
    workspaceId: operation.workspaceId,
    state: "active",
    grantedAt: "2026-08-15T09:00:00.000Z",
    expiresAt: FUTURE,
  };
}

function approvalRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const operation = binding();
  const expiresAt = overrides.expiresAt ?? FUTURE;
  return {
    schemaVersion: PERMISSION_SCHEMA_VERSION,
    approvalId: APPROVAL_ID,
    binding: operation,
    operationHash: createOperationHash(operation),
    summary: createApprovalSummary({ binding: operation, resources: [], expiresAt }),
    state: "approved",
    issuedAt: "2026-08-15T09:55:00.000Z",
    expiresAt,
    resolvedAt: "2026-08-15T09:56:00.000Z",
    consumedAt: null,
    decisionReason: "User approved the operation.",
    ...overrides,
  };
}

function approvalToken(record: ApprovalRecord): ApprovalToken {
  return {
    approvalId: record.approvalId,
    operationHash: record.operationHash,
    expiresAt: record.expiresAt,
  };
}
