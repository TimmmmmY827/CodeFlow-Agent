import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  budgetDeltaSchema,
  type BudgetPolicy,
} from "../src/policy/budget-contracts.js";
import type { Clock } from "../src/shared/contracts.js";
import { SqliteBudgetLedger } from "../src/storage/sqlite/sqlite-budget-ledger.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";

const NOW = "2026-08-15T00:00:00.000Z" as const;
const clock: Clock = { utcNow: () => NOW, monotonicNowMs: () => 0 };
const policy: BudgetPolicy = {
  limits: {
    maxSteps: 10,
    maxToolCalls: 2,
    maxDurationMs: 1_000,
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    maxCostUsd: 1,
    maxRetriesPerOperation: 3,
    maxNoProgressCycles: 3,
  },
  softLimitRatio: 0.8,
  countWaitingTime: false,
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteBudgetLedger", () => {
  it("initializes exactly once and rejects a conflicting durable policy", async () => {
    using storage = createStorage();
    const sessionId = seedSession(storage);
    const ledger = new SqliteBudgetLedger(storage);

    const first = await ledger.initialize({ sessionId, policy, pricingVersion: "pricing:test" });
    expect(await ledger.initialize({ sessionId, policy, pricingVersion: "pricing:test" })).toEqual(first);
    await expect(ledger.initialize({
      sessionId,
      policy: { ...policy, limits: { ...policy.limits, maxSteps: 11 } },
      pricingVersion: "pricing:test",
    })).rejects.toMatchObject({ details: { category: "budget_account_conflict" } });
  });

  it("atomically reserves and commits actual usage with exact idempotent replay", async () => {
    using storage = createStorage();
    const sessionId = seedSession(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId, policy, pricingVersion: "pricing:test" });
    const operationId = randomUUID();
    const reserveInput = {
      entryId: randomUUID(),
      sessionId,
      operationId,
      idempotencyKey: "model:reserve:1",
      delta: budgetDeltaSchema.parse({ steps: 1, inputTokens: 200, outputTokens: 100, costUsd: 0.2 }),
    };
    const reserved = await ledger.reserve(reserveInput);
    expect(reserved.snapshot.reserved).toMatchObject({ steps: 1, inputTokens: 200, costUsd: 0.2 });
    expect(await ledger.reserve(reserveInput)).toEqual({ ...reserved, status: "duplicate" });
    await expect(ledger.reserve({ ...reserveInput, entryId: randomUUID(), delta: budgetDeltaSchema.parse({ steps: 2 }) }))
      .rejects.toMatchObject({ details: { category: "budget_idempotency_conflict" } });

    const committed = await ledger.commit({
      entryId: randomUUID(),
      sessionId,
      operationId,
      idempotencyKey: "model:commit:1",
      reservationId: reserveInput.entryId,
      actual: budgetDeltaSchema.parse({ steps: 1, inputTokens: 150, outputTokens: 80, costUsd: 0.15 }),
    });
    expect(committed.snapshot).toMatchObject({
      usage: { steps: 1, inputTokens: 150, outputTokens: 80, costUsd: 0.15 },
      reserved: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      lastLedgerSequence: 1,
    });
  });

  it("settles missing provider usage conservatively and releases only unstarted work", async () => {
    using storage = createStorage();
    const sessionId = seedSession(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId, policy, pricingVersion: "pricing:test" });
    const operationId = randomUUID();
    const reservation = await ledger.reserve({
      entryId: randomUUID(), sessionId, operationId, idempotencyKey: "missing:reserve",
      delta: budgetDeltaSchema.parse({ inputTokens: 300, outputTokens: 100, costUsd: 0.25 }),
    });
    const settled = await ledger.commit({
      entryId: randomUUID(), sessionId, operationId, idempotencyKey: "missing:commit",
      reservationId: reservation.entry.entryId, actual: null,
    });
    expect(settled.entry).toMatchObject({ usageBasis: "conservative", reconciliationRequired: true });
    expect(settled.snapshot.usage).toMatchObject({ inputTokens: 300, outputTokens: 100, costUsd: 0.25 });

    const secondOperation = randomUUID();
    const second = await ledger.reserve({
      entryId: randomUUID(), sessionId, operationId: secondOperation, idempotencyKey: "release:reserve",
      delta: budgetDeltaSchema.parse({ toolCalls: 1 }),
    });
    const released = await ledger.release({
      entryId: randomUUID(), sessionId, operationId: secondOperation, idempotencyKey: "release:settle",
      reservationId: second.entry.entryId, operationStarted: false,
    });
    expect(released.snapshot.reserved.toolCalls).toBe(0);
  });

  it("serializes competing reservations so the hard limit cannot be over-reserved", async () => {
    const databasePath = temporaryDatabasePath();
    using firstStorage = new SqliteStorageDatabase(databasePath, { clock, busyTimeoutMs: 100 });
    const sessionId = seedSession(firstStorage);
    const first = new SqliteBudgetLedger(firstStorage);
    await first.initialize({ sessionId, policy, pricingVersion: "pricing:test" });
    using secondStorage = new SqliteStorageDatabase(databasePath, { clock, busyTimeoutMs: 100 });
    const second = new SqliteBudgetLedger(secondStorage);
    const delta = budgetDeltaSchema.parse({ toolCalls: 1 });

    const results = await Promise.allSettled([
      first.reserve({ entryId: randomUUID(), sessionId, operationId: randomUUID(), idempotencyKey: "parallel:1", delta }),
      second.reserve({ entryId: randomUUID(), sessionId, operationId: randomUUID(), idempotencyKey: "parallel:2", delta }),
      first.reserve({ entryId: randomUUID(), sessionId, operationId: randomUUID(), idempotencyKey: "parallel:3", delta }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await first.getSnapshot(sessionId)).toMatchObject({ reserved: { toolCalls: 2 }, lastLedgerSequence: 1 });
    expect((await first.listEntries(sessionId))[1]).toMatchObject({
      admission: "warn",
      warningDimensions: expect.arrayContaining(["toolCalls"]),
    });
  });

  it("replays the same snapshot after reopening and fails closed on tampering", async () => {
    const databasePath = temporaryDatabasePath();
    const sessionId = randomUUID();
    let expected;
    {
      using storage = new SqliteStorageDatabase(databasePath, { clock });
      seedSession(storage, sessionId);
      const ledger = new SqliteBudgetLedger(storage);
      await ledger.initialize({ sessionId, policy, pricingVersion: "pricing:test" });
      expected = (await ledger.adjust({
        entryId: randomUUID(), sessionId, operationId: randomUUID(), idempotencyKey: "replay:1",
        delta: budgetDeltaSchema.parse({ retries: 1, activeDurationMs: 25 }),
      })).snapshot;
    }
    using reopened = new SqliteStorageDatabase(databasePath, { clock });
    const recovered = new SqliteBudgetLedger(reopened);
    expect(await recovered.getSnapshot(sessionId)).toEqual(expected);
    reopened.database.prepare("UPDATE usage_entries SET entry_kind = 'release' WHERE session_id = ?").run(sessionId);
    await expect(recovered.getSnapshot(sessionId)).rejects.toMatchObject({ details: { category: "budget_storage_corrupt" } });
  });

  it("joins an existing execution transaction and rolls back with its event boundary", async () => {
    using storage = createStorage();
    const sessionId = seedSession(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId, policy, pricingVersion: "pricing:test" });
    storage.database.exec("BEGIN");
    ledger.reserveWithinTransaction({
      entryId: randomUUID(),
      sessionId,
      operationId: randomUUID(),
      idempotencyKey: "journal:reserve",
      delta: budgetDeltaSchema.parse({ toolCalls: 1 }),
    });
    storage.database.exec("ROLLBACK");

    expect(await ledger.listEntries(sessionId)).toEqual([]);
    expect(await ledger.getSnapshot(sessionId)).toMatchObject({ lastLedgerSequence: -1, reserved: { toolCalls: 0 } });
  });

  it("replays partial and unknown cost without coercing either to zero and preserves evidence", async () => {
    using storage = createStorage();
    const sessionId = seedSession(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({ sessionId, policy, pricingVersion: "pricing:test" });
    const observationId = randomUUID();
    await ledger.adjust({
      entryId: randomUUID(),
      sessionId,
      operationId: randomUUID(),
      idempotencyKey: "partial:adjust",
      delta: budgetDeltaSchema.parse({ costUsd: 0.1, costStatus: "partial" }),
      evidence: {
        kind: "no_progress",
        toolName: "write_file",
        effectiveInputHash: `sha256:${"c".repeat(64)}`,
        errorCategory: "same_failure",
        codeVersion: "git:test",
        firstObservationId: observationId,
        lastObservationId: observationId,
      },
    });
    const operationId = randomUUID();
    const reservation = await ledger.reserve({
      entryId: randomUUID(), sessionId, operationId, idempotencyKey: "unknown:reserve",
      delta: budgetDeltaSchema.parse({ inputTokens: 10, costUsd: 0.1 }),
    });
    const result = await ledger.commit({
      entryId: randomUUID(), sessionId, operationId, idempotencyKey: "unknown:commit",
      reservationId: reservation.entry.entryId,
      actual: budgetDeltaSchema.parse({ inputTokens: 9, costUsd: null, costStatus: "unknown" }),
    });

    expect(result.snapshot.usage).toMatchObject({ costUsd: null, costStatus: "unknown" });
    expect(await ledger.getSnapshot(sessionId)).toEqual(result.snapshot);
    expect(await ledger.listEntries(sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence: expect.objectContaining({
        kind: "no_progress",
        firstObservationId: observationId,
        lastObservationId: observationId,
      }) }),
    ]));
  });
});

function createStorage(): SqliteStorageDatabase {
  return new SqliteStorageDatabase(":memory:", { clock });
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codeflow-budget-test-"));
  directories.push(directory);
  return path.join(directory, "storage.sqlite");
}

function seedSession(storage: SqliteStorageDatabase, fixedSessionId = randomUUID()): string {
  const workspaceId = randomUUID();
  storage.database.prepare(`
INSERT INTO workspaces(workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at)
VALUES (?, 1, ?, ?, ?, ?)`)
    .run(workspaceId, `C:/workspace/${workspaceId}`, `workspace-${workspaceId}`, `fingerprint:${workspaceId}`, NOW);
  storage.database.prepare(`
INSERT INTO sessions(
  session_id, schema_version, workspace_id, goal, pinned, created_at, updated_at,
  expires_at, config_version, tool_catalog_hash, create_bundle_hash, last_sequence, deletion_state
) VALUES (?, 1, ?, 'budget test', 0, ?, ?, NULL, 'config:test', ?, ?, -1, 'active')`)
    .run(fixedSessionId, workspaceId, NOW, NOW, `sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`);
  return fixedSessionId;
}
