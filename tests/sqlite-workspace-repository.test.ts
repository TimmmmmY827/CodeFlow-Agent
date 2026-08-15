import { randomUUID } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { WorkspaceRecord } from "../src/storage/contracts.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteWorkspaceRepository } from "../src/storage/sqlite/sqlite-workspace-repository.js";

const NOW = "2026-08-15T00:00:00.000Z" as const;

describe("SqliteWorkspaceRepository", () => {
  it("returns the persisted Workspace identity by normalized path", async () => {
    using storage = new SqliteStorageDatabase(":memory:");
    const record = workspaceRecord();
    insertWorkspace(storage, record);

    await expect(new SqliteWorkspaceRepository(storage).getByNormalizedPath(record.root.normalizedPath)).resolves.toEqual(record);
  });

  it("returns null for an unknown absolute path and rejects a relative query", async () => {
    using storage = new SqliteStorageDatabase(":memory:");
    const repository = new SqliteWorkspaceRepository(storage);

    await expect(repository.getByNormalizedPath(path.resolve("unknown-workspace"))).resolves.toBeNull();
    await expect(repository.getByNormalizedPath("relative/workspace")).rejects.toMatchObject({
      details: { category: "invalid_workspace_path" },
    });
  });

  it("fails closed when stored Workspace metadata is corrupt", async () => {
    using storage = new SqliteStorageDatabase(":memory:");
    const record = workspaceRecord();
    insertWorkspace(storage, { ...record, fingerprint: "" });

    await expect(new SqliteWorkspaceRepository(storage).getByNormalizedPath(record.root.normalizedPath)).rejects.toMatchObject({
      details: { category: "storage_corrupt" },
    });
  });
});

function workspaceRecord(): WorkspaceRecord {
  const normalizedPath = path.resolve("workspace-fixture", randomUUID());
  return {
    schemaVersion: 1,
    workspaceId: randomUUID(),
    root: { normalizedPath, displayPath: normalizedPath },
    fingerprint: `fingerprint:${randomUUID()}`,
    createdAt: NOW,
  };
}

function insertWorkspace(storage: SqliteStorageDatabase, record: WorkspaceRecord): void {
  storage.database.prepare(`
INSERT INTO workspaces(workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at)
VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      record.workspaceId,
      record.schemaVersion,
      record.root.normalizedPath,
      record.root.displayPath,
      record.fingerprint,
      record.createdAt,
    );
}
