import path from "node:path";

import type { WorkspaceRecord, WorkspaceRepository } from "../contracts.js";
import { workspaceRecordSchema } from "../schemas.js";
import type { SqliteStorageDatabase } from "./sqlite-database.js";
import { StorageError, storageError, translateStorageError } from "./sqlite-errors.js";

interface WorkspaceRow {
  readonly workspace_id: unknown;
  readonly schema_version: unknown;
  readonly normalized_path: unknown;
  readonly display_path: unknown;
  readonly fingerprint: unknown;
  readonly created_at: unknown;
}

/** Read-only C02 identity lookup; Workspace creation remains atomic with Session creation. */
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly storage: SqliteStorageDatabase) {}

  async getByNormalizedPath(normalizedPath: string): Promise<WorkspaceRecord | null> {
    if (!path.isAbsolute(normalizedPath)) {
      throw storageError(
        "invalid_workspace_path",
        "normalizedPath must be an absolute workspace path.",
        false,
        "Resolve and normalize the workspace before querying its durable identity.",
      );
    }
    try {
      const row = this.storage.database.prepare(`
SELECT workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at
FROM workspaces WHERE normalized_path = ?`).get(normalizedPath) as WorkspaceRow | undefined;
      if (!row) return null;
      const parsed = workspaceRecordSchema.safeParse({
        schemaVersion: row.schema_version,
        workspaceId: row.workspace_id,
        root: { normalizedPath: row.normalized_path, displayPath: row.display_path },
        fingerprint: row.fingerprint,
        createdAt: row.created_at,
      });
      if (!parsed.success) {
        throw storageError(
          "storage_corrupt",
          `Workspace metadata is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          false,
          "Stop writes and inspect or restore the Workspace record.",
        );
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }
  }
}
