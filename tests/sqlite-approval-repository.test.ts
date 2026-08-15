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
const AFTER_EXPIRY = "2026-08-15T10:06:00.000Z" as const;
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
    fixture.clock.now = AFTER_EXPIRY;
    await expect(recovered.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null }))
      .rejects.toMatchObject({ details: { category: "approval_transition_invalid" } });
    await expect(recovered.get(APPROVAL_ID)).resolves.toMatchObject({ state: "consumed" });
  });

  it("supports rollback as a C08 transaction participant", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    await repository.issue(issueInput());
    fixture.clock.now = APPROVED_AT;
    await repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null });

    storage.database.exec("BEGIN");
    expect(() => repository.consumeWithinTransaction({
      approvalId: APPROVAL_ID,
      operationHash: createOperationHash(binding()),
    })).toThrowError(expect.objectContaining({
      details: expect.objectContaining({ category: "approval_transaction_required" }),
    }));
    storage.database.exec("ROLLBACK");

    expect(() => storage.runImmediateTransaction(() => {
      repository.consumeWithinTransaction({
        approvalId: APPROVAL_ID,
        operationHash: createOperationHash(binding()),
      });
      throw new Error("journal fault after approval consumption");
    })).toThrow("journal fault");

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
    fixture.clock.now = AFTER_EXPIRY;
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

  it("lazily persists expiry on get and supports explicit approved invalidation", async () => {
    const expiryFixture = createFixture();
    using expiryStorage = expiryFixture.storage;
    const expiryRepository = new SqliteApprovalRepository(expiryStorage);
    await expiryRepository.issue(issueInput());
    expiryFixture.clock.now = EXPIRES_AT;

    await expect(expiryRepository.get(APPROVAL_ID)).resolves.toMatchObject({
      state: "expired",
      decisionReason: "Approval reached its expiration.",
    });
    expect(expiryStorage.database
      .prepare("SELECT decision FROM approvals WHERE approval_id = ?")
      .get(APPROVAL_ID)).toEqual({ decision: "expired" });

    const explicitExpiryFixture = createFixture();
    using explicitExpiryStorage = explicitExpiryFixture.storage;
    const explicitExpiryRepository = new SqliteApprovalRepository(explicitExpiryStorage);
    await explicitExpiryRepository.issue(issueInput());
    explicitExpiryFixture.clock.now = EXPIRES_AT;
    await expect(explicitExpiryRepository.expire(APPROVAL_ID))
      .resolves.toMatchObject({ state: "expired" });

    const invalidateFixture = createFixture();
    using invalidateStorage = invalidateFixture.storage;
    const invalidateRepository = new SqliteApprovalRepository(invalidateStorage);
    await invalidateRepository.issue(issueInput());
    invalidateFixture.clock.now = APPROVED_AT;
    await invalidateRepository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null });
    await expect(invalidateRepository.invalidate(APPROVAL_ID, "The code snapshot changed."))
      .resolves.toMatchObject({ state: "invalidated", decisionReason: "The code snapshot changed." });
    invalidateFixture.clock.now = AFTER_EXPIRY;
    await expect(invalidateRepository.resolve({
      approvalId: APPROVAL_ID,
      decision: "approved",
      reason: null,
    })).rejects.toMatchObject({ details: { category: "approval_transition_invalid" } });
    await expect(invalidateRepository.get(APPROVAL_ID)).resolves.toMatchObject({ state: "invalidated" });
    await expect(invalidateRepository.consume({
      approvalId: APPROVAL_ID,
      operationHash: createOperationHash(binding()),
    })).rejects.toMatchObject({ details: { category: "approval_transition_invalid" } });
  });

  it("blocks decisions and consumption once Session deletion begins", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    await repository.issue(issueInput());
    fixture.clock.now = APPROVED_AT;
    storage.database.prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
      .run(binding().sessionId);

    await expect(repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null }))
      .rejects.toMatchObject({ details: { category: "approval_session_unavailable" } });

    storage.database.prepare("UPDATE sessions SET deletion_state = 'active' WHERE session_id = ?")
      .run(binding().sessionId);
    await repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null });
    storage.database.prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
      .run(binding().sessionId);
    await expect(repository.consume({
      approvalId: APPROVAL_ID,
      operationHash: createOperationHash(binding()),
    })).rejects.toMatchObject({ details: { category: "approval_session_unavailable" } });
  });

  it("reports an injected Clock rollback as an approval error without changing state", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    await repository.issue(issueInput());
    fixture.clock.now = "2026-08-15T09:59:00.000Z";

    await expect(repository.resolve({ approvalId: APPROVAL_ID, decision: "approved", reason: null }))
      .rejects.toMatchObject({ details: { category: "approval_clock_regressed" } });
    await expect(repository.get(APPROVAL_ID)).resolves.toMatchObject({ state: "issued" });
  });

  it("rejects preserved v1 approval rows that lack a complete binding", async () => {
    const fixture = createFixture();
    using storage = fixture.storage;
    storage.database.prepare(`
INSERT INTO approvals(
  approval_id, session_id, schema_version, tool_name, operation_hash,
  decision, expires_at, decided_at
) VALUES (?, ?, 1, 'publish', 'legacy-hash', 'approved', ?, ?)`)
      .run(APPROVAL_ID, binding().sessionId, EXPIRES_AT, ISSUED_AT);

    await expect(new SqliteApprovalRepository(storage).get(APPROVAL_ID)).rejects.toMatchObject({
      details: { category: "legacy_approval_unusable" },
    });
  });

  it.each([
    ["indexed operation hash", "UPDATE approvals SET operation_hash = ? WHERE approval_id = ?", hash("f")],
    ["indexed tool name", "UPDATE approvals SET tool_name = ? WHERE approval_id = ?", "other_tool"],
    ["canonical JSON", "UPDATE approvals SET record_json = ? WHERE approval_id = ?", "{"],
    ["canonical record hash", "UPDATE approvals SET record_hash = ? WHERE approval_id = ?", hash("b")],
  ])("fails closed when %s is tampered", async (_label, statement, value) => {
    const fixture = createFixture();
    using storage = fixture.storage;
    const repository = new SqliteApprovalRepository(storage);
    await repository.issue(issueInput());

    storage.database.prepare(statement).run(value, APPROVAL_ID);
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
