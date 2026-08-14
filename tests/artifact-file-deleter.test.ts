import path from "node:path";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import {
  createStableId,
  type Clock,
} from "../src/shared/contracts.js";
import { FileArtifactDeleter } from "../src/storage/artifacts/artifact-file-deleter.js";
import { FileArtifactStore } from "../src/storage/artifacts/file-artifact-store.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type CreateSessionBundle,
} from "../src/storage/contracts.js";
import { SessionDeletionService } from "../src/storage/session-deletion-service.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteSessionRepository } from "../src/storage/sqlite/sqlite-session-repository.js";

const NOW = "2026-08-12T12:00:00.000Z";
const clock: Clock = { utcNow: () => NOW, monotonicNowMs: () => 0 };
const cleanupDirectories: string[] = [];
const openDatabases: SqliteStorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0).reverse()) database.close();
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe("FileArtifactDeleter", () => {
  it("deletes ready and staged FileArtifactStore names idempotently", async () => {
    const { dataDirectory, storage } = await boundDataDirectoryFixture();
    const sessionId = createStableId();
    const artifactId = createStableId();
    const nonce = createStableId();
    const sessionDirectory = path.join(dataDirectory, "artifacts", sessionId);
    await mkdir(sessionDirectory, { recursive: true });
    const deleter = new FileArtifactDeleter(dataDirectory, storage);
    const readyRelativePath = `artifacts/${sessionId}/${artifactId}.bin`;
    const stagedRelativePath = `artifacts/${sessionId}/.${artifactId}.${nonce}.tmp`;
    await writeFile(path.join(sessionDirectory, `${artifactId}.bin`), "ready");
    await writeFile(path.join(sessionDirectory, `.${artifactId}.${nonce}.tmp`), "staged");

    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: readyRelativePath,
    })).resolves.toBe("deleted");
    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: stagedRelativePath,
    })).resolves.toBe("deleted");
    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: readyRelativePath,
    })).resolves.toBe("missing");
  });

  it.each([
    ["traversal", (sessionId: string, artifactId: string) => `../${sessionId}/${artifactId}.bin`, "artifact_path_outside_data_dir"],
    ["Windows absolute", (_sessionId: string, artifactId: string) => `C:\\outside\\${artifactId}.bin`, "artifact_path_outside_data_dir"],
    ["POSIX absolute", (_sessionId: string, artifactId: string) => `/outside/${artifactId}.bin`, "artifact_path_outside_data_dir"],
    ["cross Session", (_sessionId: string, artifactId: string) => `artifacts/${createStableId()}/${artifactId}.bin`, "artifact_path_outside_data_dir"],
    ["wrong Artifact", (sessionId: string) => `artifacts/${sessionId}/${createStableId()}.bin`, "artifact_identity_mismatch"],
    ["forged staged name", (sessionId: string, artifactId: string) => `artifacts/${sessionId}/.${artifactId}.not-a-uuid.tmp`, "artifact_identity_mismatch"],
    ["nested file", (sessionId: string, artifactId: string) => `artifacts/${sessionId}/nested/${artifactId}.bin`, "artifact_path_outside_data_dir"],
  ])("rejects a %s path before filesystem deletion", async (
    _label,
    relativePath,
    category,
  ) => {
    const { dataDirectory, storage } = await boundDataDirectoryFixture();
    const sessionId = createStableId();
    const artifactId = createStableId();
    const outside = path.join(path.dirname(dataDirectory), `${artifactId}.bin`);
    await writeFile(outside, "must remain");
    const deleter = new FileArtifactDeleter(dataDirectory, storage);

    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: relativePath(sessionId, artifactId),
    })).rejects.toMatchObject({ details: { category } });
    await expect(readFile(outside, "utf8")).resolves.toBe("must remain");
  });

  it("rejects a Session-directory junction that resolves outside the data root", async () => {
    const fixtureRoot = await trackedTempDirectory("codeflow-file-delete-junction-");
    const dataDirectory = path.join(fixtureRoot, "data");
    const outsideDirectory = path.join(fixtureRoot, "outside");
    const sessionId = createStableId();
    const artifactId = createStableId();
    await mkdir(path.join(dataDirectory, "artifacts"), { recursive: true });
    const storage = await bindDataDirectory(dataDirectory);
    await mkdir(outsideDirectory, { recursive: true });
    const outsideFile = path.join(outsideDirectory, `${artifactId}.bin`);
    await writeFile(outsideFile, "must remain");
    const sessionDirectory = path.join(dataDirectory, "artifacts", sessionId);
    try {
      await symlink(outsideDirectory, sessionDirectory, "junction");
    } catch (error: unknown) {
      if (isUnsupportedLink(error)) return;
      throw error;
    }

    const deleter = new FileArtifactDeleter(dataDirectory, storage);
    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: `artifacts/${sessionId}/${artifactId}.bin`,
    })).rejects.toMatchObject({
      details: {
        category: expect.stringMatching(/^artifact_path_(?:invalid|outside_data_dir)$/u),
      },
    });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("must remain");
  });

  it("rejects a file symlink even when its apparent path has valid identities", async () => {
    const fixtureRoot = await trackedTempDirectory("codeflow-file-delete-link-");
    const dataDirectory = path.join(fixtureRoot, "data");
    const sessionId = createStableId();
    const artifactId = createStableId();
    const sessionDirectory = path.join(dataDirectory, "artifacts", sessionId);
    await mkdir(sessionDirectory, { recursive: true });
    const storage = await bindDataDirectory(dataDirectory);
    const outsideFile = path.join(fixtureRoot, "outside.bin");
    await writeFile(outsideFile, "must remain");
    const candidate = path.join(sessionDirectory, `${artifactId}.bin`);
    try {
      await symlink(outsideFile, candidate, "file");
    } catch (error: unknown) {
      if (isUnsupportedLink(error)) return;
      throw error;
    }

    const deleter = new FileArtifactDeleter(dataDirectory, storage);
    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: `artifacts/${sessionId}/${artifactId}.bin`,
    })).rejects.toMatchObject({ details: { category: "artifact_path_invalid" } });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("must remain");
  });

  it("fails retryably instead of reporting missing when the data root is unavailable", async () => {
    const fixtureRoot = await trackedTempDirectory("codeflow-file-delete-root-missing-");
    const dataDirectory = path.join(fixtureRoot, "unavailable-data");
    const storage = createStorage(path.join(fixtureRoot, "storage", "codeflow.sqlite"));
    const deleter = new FileArtifactDeleter(dataDirectory, storage);
    const sessionId = createStableId();
    const artifactId = createStableId();

    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: `artifacts/${sessionId}/${artifactId}.bin`,
    })).rejects.toMatchObject({
      details: { category: "artifact_storage_unavailable", retryable: true },
    });
  });

  it("fails retryably when the Artifact or Session parent is unavailable", async () => {
    const { dataDirectory, storage } = await boundDataDirectoryFixture();
    const deleter = new FileArtifactDeleter(dataDirectory, storage);
    const sessionId = createStableId();
    const artifactId = createStableId();
    const request = {
      sessionId,
      artifactId,
      relativePath: `artifacts/${sessionId}/${artifactId}.bin`,
    };

    await rm(path.join(dataDirectory, "artifacts"), { recursive: true });
    await expect(deleter.deleteArtifactFile(request)).rejects.toMatchObject({
      details: { category: "artifact_storage_unavailable", retryable: true },
    });
    await mkdir(path.join(dataDirectory, "artifacts"));
    await expect(deleter.deleteArtifactFile(request)).rejects.toMatchObject({
      details: { category: "artifact_storage_unavailable", retryable: true },
    });
  });

  it("reports only a missing candidate after every trusted parent is accessible", async () => {
    const { dataDirectory, storage } = await boundDataDirectoryFixture();
    const sessionId = createStableId();
    const artifactId = createStableId();
    await mkdir(path.join(dataDirectory, "artifacts", sessionId), { recursive: true });
    const deleter = new FileArtifactDeleter(dataDirectory, storage);

    await expect(deleter.deleteArtifactFile({
      sessionId,
      artifactId,
      relativePath: `artifacts/${sessionId}/${artifactId}.bin`,
    })).resolves.toBe("missing");
  });

  it("integrates FileArtifactStore output with complete Session deletion", async () => {
    const dataDirectory = await dataDirectoryFixture();
    const database = new SqliteStorageDatabase(path.join(dataDirectory, "codeflow.sqlite"), { clock });
    openDatabases.push(database);
    const bundle = sessionBundle(dataDirectory);
    await sessionRepository(database).create(bundle);
    const artifactStore = new FileArtifactStore(database, dataDirectory);
    const reference = await artifactStore.write(
      bundle.session.sessionId,
      "text/plain",
      new TextEncoder().encode("erase me"),
      "normal",
    );
    const artifactPath = path.join(dataDirectory, ...reference.relativePath.split("/"));
    await expect(readFile(artifactPath, "utf8")).resolves.toBe("erase me");

    const service = new SessionDeletionService(database, {
      artifactFileDeleter: new FileArtifactDeleter(dataDirectory, database),
      referenceHashKey: "test-only-install-local-key",
    });
    const receipt = await service.delete(bundle.session.sessionId);

    expect(receipt.status).toBe("complete");
    expect(receipt.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "artifact_file", status: "deleted" }),
      expect.objectContaining({ target: "artifact_metadata", status: "deleted" }),
      expect.objectContaining({ target: "session", status: "deleted" }),
    ]));
    await expect(readFile(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.dirname(artifactPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(database.database
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
      .get(bundle.session.sessionId)).toEqual({ count: 0 });
    expect(database.database
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE artifact_id = ?")
      .get(reference.artifactId)).toEqual({ count: 0 });
  });

  it("removes untracked owned temp files and the raw Session directory before completion", async () => {
    const dataDirectory = await dataDirectoryFixture();
    const storage = createStorage(path.join(dataDirectory, "codeflow.sqlite"));
    const bundle = sessionBundle(dataDirectory);
    await sessionRepository(storage).create(bundle);
    const store = new FileArtifactStore(storage, dataDirectory);
    await store.recover();
    const artifactId = createStableId();
    const sessionDirectory = path.join(dataDirectory, "artifacts", bundle.session.sessionId);
    await mkdir(sessionDirectory, { recursive: true });
    const orphan = path.join(sessionDirectory, `.${artifactId}.${createStableId()}.tmp`);
    await writeFile(orphan, "untracked sensitive temp");
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: new FileArtifactDeleter(dataDirectory, storage),
      referenceHashKey: "test-only-install-local-key",
    });

    await expect(service.delete(bundle.session.sessionId)).resolves.toMatchObject({
      status: "complete",
    });
    await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the Session directory contains an unowned entry", async () => {
    const dataDirectory = await dataDirectoryFixture();
    const storage = createStorage(path.join(dataDirectory, "codeflow.sqlite"));
    const bundle = sessionBundle(dataDirectory);
    await sessionRepository(storage).create(bundle);
    await new FileArtifactStore(storage, dataDirectory).recover();
    const sessionDirectory = path.join(dataDirectory, "artifacts", bundle.session.sessionId);
    await mkdir(sessionDirectory, { recursive: true });
    const unknownFile = path.join(sessionDirectory, "foreign-entry.txt");
    await writeFile(unknownFile, "must not be silently removed");
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: new FileArtifactDeleter(dataDirectory, storage),
      referenceHashKey: "test-only-install-local-key",
    });

    const receipt = await service.delete(bundle.session.sessionId);

    expect(receipt.status).toBe("failed");
    expect(receipt.error).toEqual(expect.objectContaining({
      category: "artifact_session_directory_not_empty",
    }));
    expect(receipt.items).toContainEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ category: "artifact_session_directory_not_empty" }),
    }));
    await expect(readFile(unknownFile, "utf8")).resolves.toBe("must not be silently removed");
    expect(storage.database
      .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
      .get(bundle.session.sessionId)).toEqual({ deletion_state: "deleting" });
    expect(storage.database
      .prepare("SELECT COUNT(*) AS count FROM deleted_session_tombstones")
      .get()).toEqual({ count: 0 });
  });

  it("does not leave a pre-staging temp file when Session deletion wins the race", async () => {
    const dataDirectory = await dataDirectoryFixture();
    const storage = createStorage(path.join(dataDirectory, "codeflow.sqlite"));
    const bundle = sessionBundle(dataDirectory);
    await sessionRepository(storage).create(bundle);
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let tempWritten!: () => void;
    const observedTemp = new Promise<void>((resolve) => {
      tempWritten = resolve;
    });
    const store = new FileArtifactStore(storage, dataDirectory, {
      faultInjector: {
        async hit(point) {
          if (point !== "artifact_after_temp_write") return;
          tempWritten();
          await writeReleased;
        },
      },
    });
    const write = store.write(
      bundle.session.sessionId,
      "text/plain",
      new TextEncoder().encode("race-sensitive-temp"),
      "sensitive",
    );
    await observedTemp;
    const sessionDirectory = path.join(dataDirectory, "artifacts", bundle.session.sessionId);
    await expect(readdir(sessionDirectory)).resolves.not.toEqual([]);

    const deletion = new SessionDeletionService(storage, {
      artifactFileDeleter: new FileArtifactDeleter(dataDirectory, storage),
      referenceHashKey: "test-only-install-local-key",
    });
    await expect(deletion.delete(bundle.session.sessionId)).resolves.toMatchObject({ status: "complete" });
    releaseWrite();
    await expect(write).rejects.toMatchObject({
      details: { category: "session_not_found" },
    });
    await expect(access(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails deletion when a complete but non-authoritative Artifact root is supplied", async () => {
    const authoritativeRoot = await dataDirectoryFixture();
    const storage = createStorage(path.join(authoritativeRoot, "codeflow.sqlite"));
    const bundle = sessionBundle(authoritativeRoot);
    await sessionRepository(storage).create(bundle);
    const reference = await new FileArtifactStore(storage, authoritativeRoot).write(
      bundle.session.sessionId,
      "text/plain",
      new TextEncoder().encode("must remain in authoritative root"),
      "normal",
    );
    const authoritativeFile = path.join(
      authoritativeRoot,
      ...reference.relativePath.split("/"),
    );

    const wrongRoot = await dataDirectoryFixture();
    await mkdir(path.join(wrongRoot, "artifacts", bundle.session.sessionId), { recursive: true });
    const service = new SessionDeletionService(storage, {
      artifactFileDeleter: new FileArtifactDeleter(wrongRoot, storage),
      referenceHashKey: "test-only-install-local-key",
    });

    const receipt = await service.delete(bundle.session.sessionId);

    expect(receipt.status).toBe("failed");
    expect(receipt.items).toContainEqual(expect.objectContaining({
      target: "artifact_file",
      status: "failed",
      error: expect.objectContaining({ category: "artifact_root_mismatch" }),
    }));
    await expect(readFile(authoritativeFile, "utf8"))
      .resolves.toBe("must remain in authoritative root");
    expect(storage.database
      .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
      .get(bundle.session.sessionId)).toEqual({ deletion_state: "deleting" });
    expect(storage.database
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE artifact_id = ?")
      .get(reference.artifactId)).toEqual({ count: 1 });
    expect(storage.database
      .prepare("SELECT COUNT(*) AS count FROM deleted_session_tombstones")
      .get()).toEqual({ count: 0 });
  });
});

async function dataDirectoryFixture(): Promise<string> {
  const root = await trackedTempDirectory("codeflow-file-delete-");
  const dataDirectory = path.join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  return dataDirectory;
}

async function boundDataDirectoryFixture(): Promise<{
  readonly dataDirectory: string;
  readonly storage: SqliteStorageDatabase;
}> {
  const dataDirectory = await dataDirectoryFixture();
  return { dataDirectory, storage: await bindDataDirectory(dataDirectory) };
}

async function bindDataDirectory(dataDirectory: string): Promise<SqliteStorageDatabase> {
  const storage = createStorage(path.join(dataDirectory, "codeflow.sqlite"));
  await new FileArtifactStore(storage, dataDirectory).recover();
  return storage;
}

function createStorage(databasePath: string): SqliteStorageDatabase {
  const storage = new SqliteStorageDatabase(databasePath, { clock });
  openDatabases.push(storage);
  return storage;
}

function sessionRepository(storage: SqliteStorageDatabase): SqliteSessionRepository {
  return new SqliteSessionRepository(storage, {
    deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
  });
}

async function trackedTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

function sessionBundle(workspaceRoot: string): CreateSessionBundle {
  const sessionId = createStableId();
  const workspaceId = createStableId();
  const taskId = createStableId();
  const goal = "Integrate safe Artifact deletion";
  const createdEvent = createAgentEvent({
    sessionId,
    taskId,
    actorId: "agent:primary",
    sequence: 0,
    type: "session.created",
    context: createEventContext({ workspacePath: workspaceRoot, configVersion: "config:v1" }),
    payload: { goal },
    occurredAt: NOW,
  });
  return {
    session: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId,
      workspace: {
        schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
        workspaceId,
        root: { normalizedPath: workspaceRoot, displayPath: workspaceRoot },
        fingerprint: `fingerprint:${workspaceId}`,
        createdAt: NOW,
      },
      goal,
      createdAt: NOW,
      expiresAt: null,
      configVersion: "config:v1",
      toolCatalogHash: `sha256:${"a".repeat(64)}`,
    },
    rootTask: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      taskId,
      actorId: "agent:primary",
      title: goal,
      createdAt: NOW,
    },
    createdEvent,
  };
}

function isUnsupportedLink(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}
