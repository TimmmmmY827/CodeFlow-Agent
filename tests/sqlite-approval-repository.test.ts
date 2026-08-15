import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApprovalSummary } from "../src/policy/approval-summary.js";
import { createOperationHash } from "../src/policy/operation-hash.js";
import { SqliteApprovalRepository } from "../src/storage/sqlite/sqlite-approval-repository.js";
import type { Clock, UtcTimestamp } from "../src/shared/contracts.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { binding, hash } from "./fixtures/permission.js";

const ISSUED_AT = "2026-08-15T10:00:00.000Z" as const;
const APPROVED_AT = "2026-08-15T10:01:00.000Z" as const;
const EXPIRES_AT = "2026-08-15T10:05:00.000Z" as const;
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteApprovalRepository", () => {
  it("issues an exact request idempotently and rejects an ID rebound", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    const request = issueInput();

    await expect(repository.issue(request)).resolves.toBe("inserted");
    await expect(repository.issue(request)).resolves.toBe("duplicate");
    fixture.clock.now = "2026-08-15T10:02:00.000Z";
    await expect(repository.issue(request)).resolves.toBe("duplicate");
    await expect(repository.issue({
      ...request,
      binding: binding({ configVersion: "config:v2" }),
      summary: createApprovalSummary({
        binding: binding({ configVersion: "config:v2" }),
        resources: [],
        expiresAt: EXPIRES_AT,
      }),
    })).rejects.toMatchObject({ details: { category: "approval_id_conflict" } });

    await expect(repository.get(APPROVAL_ID)).resolves.toMatchObject({
      state: "issued",
      operationHash: createOperationHash(binding()),
    });
  });

  it("persists one-time consumption before a failed execution and across restart", async () => {
    const fixture = createFixture(true);
    let operationHash: string;
    {
      using storage = fixture.storage;
      const repository = new SqliteApprovalRepository(storage);
      await repository.issue(issueInput());
      fixture.clock.now = APPROVED_AT;
      await repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null });
      operationHash = createOperationHash(binding());
      await expect(repository.consume({ approvalId: APPROVAL_ID, operationHash })).resolves.toMatchObject({
        state: "consumed",
        consumedAt: APPROVED_AT,
      });

      // The external tool can fail after this point. Consumption remains a
      // durable fact and is never compensated back to approved.
      expect(() => { throw new Error("connection dropped after publish"); }).toThrow();
    }

    using reopened = new SqliteStorageDatabase(fixture.databasePath, { clock: fixture.clock });
    const recovered = new SqliteApprovalRepository(reopened);
    await expect(recovered.consume({ approvalId: APPROVAL_ID, operationHash: operationHash! }))
      .rejects.toMatchObject({ details: { category: "approval_already_consumed" } });
    await expect(recovered.get(APPROVAL_ID)).resolves.toMatchObject({ state: "consumed" });
  });

  it("supports rollback as a C08 transaction participant", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    await repository.issue(issueInput());
    fixture.clock.now = APPROVED_AT;
    await repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null });

    storage.database.exec("BEGIN IMMEDIATE");
    repository.consumeWithinTransaction({
      approvalId: APPROVAL_ID,
      operationHash: createOperationHash(binding()),
    });
    storage.database.exec("ROLLBACK");

    await expect(repository.get(APPROVAL_ID)).resolves.toMatchObject({ state: "approved" });
    expect(() => repository.consumeWithinTransaction({
      approvalId: APPROVAL_ID,
      operationHash: createOperationHash(binding()),
    })).toThrowError(expect.objectContaining({
      details: expect.objectContaining({ category: "approval_transaction_required" }),
    }));
  });

  it("records denial as terminal and refuses automatic re-prompt transitions", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    await repository.issue(issueInput());
    fixture.clock.now = APPROVED_AT;

    await expect(repository.resolve({
      approvalId: APPROVAL_ID,
      decision: "denied",
      reason: "Do not publish this branch.",
    })).resolves.toMatchObject({ state: "denied", decisionReason: "Do not publish this branch." });
    await expect(repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null }))
      .rejects.toMatchObject({ details: { category: "approval_transition_invalid" } });
    await expect(repository.consume({
      approvalId: APPROVAL_ID,
      operationHash: createOperationHash(binding()),
    })).rejects.toMatchObject({ details: { category: "approval_transition_invalid" } });
  });

  it("expires exactly at the injected clock boundary and remains expired after restart", async () => {
    const fixture = createFixture(true);
    {
      using storage = fixture.storage;
      const repository = new SqliteApprovalRepository(storage);
      await repository.issue(issueInput());
      fixture.clock.now = APPROVED_AT;
      await repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null });
      fixture.clock.now = EXPIRES_AT;
      await expect(repository.consume({
        approvalId: APPROVAL_ID,
        operationHash: createOperationHash(binding()),
      })).rejects.toMatchObject({ details: { category: "approval_expired" } });
      await expect(repository.get(APPROVAL_ID)).resolves.toMatchObject({ state: "expired" });
    }

    using reopened = new SqliteStorageDatabase(fixture.databasePath, { clock: fixture.clock });
    await expect(new SqliteApprovalRepository(reopened).get(APPROVAL_ID))
      .resolves.toMatchObject({ state: "expired" });
  });

  it("fails closed when canonical approval JSON or indexed facts are tampered", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    await repository.issue(issueInput());

    storage.database.prepare("UPDATE approvals SET operation_hash = ? WHERE approval_id = ?")
      .run(hash("f"), APPROVAL_ID);
    await expect(repository.get(APPROVAL_ID)).rejects.toMatchObject({
      details: { category: "approval_storage_corrupt" },
    });
  });
});

function issueInput() {
  const operation = binding();
  return {
    approvalId: APPROVAL_ID,
    binding: operation,
    expiresAt: EXPIRES_AT,
    summary: createApprovalSummary({
      binding: operation,
      resources: [
        { kind: "remote" as const, value: "origin" },
        { kind: "branch" as const, value: "codex/c03-permission-engine" },
      ],
      expiresAt: EXPIRES_AT,
    }),
  };
}

function createFixture(file = false): {
  readonly storage: SqliteStorageDatabase;
  readonly databasePath: string;
  readonly clock: MutableClock;
} {
  const clock = new MutableClock(ISSUED_AT);
  const directory = mkdtempSync(path.join(os.tmpdir(), "codeflow-approval-test-"));
  temporaryDirectories.push(directory);
  const databasePath = file ? path.join(directory, "storage.sqlite") : ":memory:";
  const storage = new SqliteStorageDatabase(databasePath, { clock });
  seedBindingOwners(storage);
  return { storage, databasePath, clock };
}

function seedBindingOwners(storage: SqliteStorageDatabase): void {
  const operation = binding();
  storage.database.prepare(`
INSERT INTO workspaces(
  workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at
) VALUES (?, 1, ?, ?, ?, ?)`)
    .run(operation.workspaceId, "C:/workspace", "C:/workspace", "workspace:fingerprint", ISSUED_AT);
  storage.database.prepare(`
INSERT INTO sessions(
  session_id, schema_version, workspace_id, goal, pinned, created_at, updated_at,
  expires_at, config_version, tool_catalog_hash, create_bundle_hash, last_sequence, deletion_state
) VALUES (?, 1, ?, ?, 0, ?, ?, NULL, ?, ?, ?, -1, 'active')`)
    .run(
      operation.sessionId,
      operation.workspaceId,
      "Test durable approval",
      ISSUED_AT,
      ISSUED_AT,
      operation.configVersion,
      hash("e"),
      hash("d"),
    );
  storage.database.prepare(`
INSERT INTO tasks(
  task_id, schema_version, session_id, parent_task_id, actor_id, title, created_at, create_record_hash
) VALUES (?, 1, ?, NULL, 'actor:test', 'Root task', ?, ?)`)
    .run(operation.taskId, operation.sessionId, ISSUED_AT, hash("c"));
}

class MutableClock implements Clock {
  constructor(public now: UtcTimestamp) {}
  utcNow(): UtcTimestamp { return this.now; }
  monotonicNowMs(): number { return 0; }
}
