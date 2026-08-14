import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStableId, type ArtifactReference, type Clock } from "../src/shared/contracts.js";
import type { StorageFaultPoint } from "../src/storage/contracts.js";
import { FileArtifactStore } from "../src/storage/artifacts/file-artifact-store.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";

const FIXED_NOW = "2026-08-12T12:00:00.000Z";
const clock: Clock = {
  utcNow: () => FIXED_NOW,
  monotonicNowMs: () => 0,
};

const cleanupDirectories: string[] = [];
const openDatabases: SqliteStorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0).reverse()) database.close();
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    await rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe("FileArtifactStore", () => {
  it.each([
    ["empty", new Uint8Array()],
    ["utf8", new TextEncoder().encode("确定性 Artifact 内容")],
    ["binary", Uint8Array.from({ length: 128 * 1024 }, (_value, index) => index % 251)],
  ])("writes, reopens, reads, and verifies %s content", async (_label, content) => {
    const fixture = await storageFixture();
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory);
    const reference = await store.write(
      fixture.sessionId,
      "application/octet-stream",
      content,
      "sensitive",
    );

    expect(reference).toMatchObject({
      byteLength: content.byteLength,
      mediaType: "application/octet-stream",
      sensitivity: "sensitive",
    });
    expect(reference.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(reference.relativePath).not.toContain("\\");
    await expect(store.verify(fixture.sessionId, reference)).resolves.toBe(true);
    await expect(store.read(fixture.sessionId, reference)).resolves.toEqual(content);

    fixture.database.close();
    const reopened = openDatabase(fixture.databasePath);
    const reopenedStore = new FileArtifactStore(reopened, fixture.dataDirectory);
    await expect(reopenedStore.read(fixture.sessionId, reference)).resolves.toEqual(content);
  });

  it("marks a tampered ready Artifact corrupt and refuses to read it", async () => {
    const fixture = await storageFixture();
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory);
    const reference = await store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("trusted"),
      "normal",
    );
    await writeFile(path.join(fixture.dataDirectory, ...reference.relativePath.split("/")), "tampered");

    await expect(store.verify(fixture.sessionId, reference)).resolves.toBe(false);
    await expect(store.read(fixture.sessionId, reference)).rejects.toMatchObject({
      details: { category: "artifact_not_ready" },
    });
    expect(artifactState(fixture.database, reference.artifactId)).toBe("corrupt");
  });

  it("reports a missing ready file and blocks writes once Session deletion starts", async () => {
    const fixture = await storageFixture();
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory);
    const reference = await store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("will disappear"),
      "normal",
    );
    await rm(path.join(fixture.dataDirectory, ...reference.relativePath.split("/")));

    await expect(store.read(fixture.sessionId, reference)).rejects.toMatchObject({
      details: { category: "artifact_missing" },
    });

    fixture.database.database
      .prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
      .run(fixture.sessionId);
    await expect(store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("too late"),
      "normal",
    )).rejects.toMatchObject({ details: { category: "session_deleting" } });
  });

  it("binds the authoritative Artifact root to the storage installation", async () => {
    const fixture = await storageFixture();
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory);
    await store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("bound root"),
      "normal",
    );
    const otherRoot = await trackedTempDirectory("codeflow-other-root-");
    await mkdir(otherRoot, { recursive: true });
    const mismatched = new FileArtifactStore(fixture.database, otherRoot);

    await expect(mismatched.recover()).rejects.toMatchObject({
      details: { category: "artifact_root_mismatch" },
    });
  });

  it("rejects forged paths, metadata, cross-Session access, and junction escape", async () => {
    const fixture = await storageFixture();
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory);
    const reference = await store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("inside"),
      "normal",
    );

    const traversal = { ...reference, relativePath: `../outside/${reference.artifactId}.bin` };
    await expect(store.read(fixture.sessionId, traversal)).rejects.toMatchObject({
      details: { category: "artifact_path_outside_data_dir" },
    });
    const windowsAbsolute = { ...reference, relativePath: "C:\\outside\\artifact.bin" };
    await expect(store.verify(fixture.sessionId, windowsAbsolute)).rejects.toMatchObject({
      details: { category: "artifact_path_outside_data_dir" },
    });
    await expect(store.read(fixture.sessionId, { ...reference, sha256: "sha256:forged" }))
      .rejects.toMatchObject({ details: { category: "artifact_metadata_invalid" } });
    await expect(store.read(createStableId(), reference)).rejects.toMatchObject({
      details: { category: "artifact_not_found" },
    });

    const outside = await trackedTempDirectory("codeflow-artifact-outside-");
    const outsideFile = path.join(outside, `${reference.artifactId}.bin`);
    await writeFile(outsideFile, "outside");
    const sessionDirectory = path.dirname(
      path.join(fixture.dataDirectory, ...reference.relativePath.split("/")),
    );
    const originalDirectory = `${sessionDirectory}-original`;
    await import("node:fs/promises").then(({ rename }) => rename(sessionDirectory, originalDirectory));
    let junctionCreated = false;
    try {
      await symlink(outside, sessionDirectory, "junction");
      junctionCreated = true;
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : null;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
    }
    if (junctionCreated) {
      await expect(store.read(fixture.sessionId, reference)).rejects.toMatchObject({
        details: { category: "artifact_path_outside_data_dir" },
      });
    }
  });

  it.each([
    ["artifact_after_staged"],
    ["artifact_after_rename"],
  ] as const)("recovers an interrupted commit at %s", async (faultPoint) => {
    const fixture = await storageFixture();
    const fault = oneShotFault(faultPoint);
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory, {
      faultInjector: fault,
    });
    const content = new TextEncoder().encode(`recover ${faultPoint}`);

    await expect(store.write(fixture.sessionId, "text/plain", content, "normal"))
      .rejects.toMatchObject({ details: { category: "storage_operation_failed" } });
    const row = onlyArtifact(fixture.database);
    expect(row.state).toBe("staged");

    fixture.database.close();
    const reopened = openDatabase(fixture.databasePath);
    const recoveredStore = new FileArtifactStore(reopened, fixture.dataDirectory);
    await expect(recoveredStore.recover()).resolves.toMatchObject({ resumed: 1, ready: 1, corrupt: 0 });
    const reference = referenceFromRow(reopened, row.artifactId);
    await expect(recoveredStore.read(fixture.sessionId, reference)).resolves.toEqual(content);
    await expect(recoveredStore.recover()).resolves.toMatchObject({ resumed: 0, corrupt: 0 });
  });

  it("leaves a pre-staging interruption unreferenced and removes it as an orphan", async () => {
    const fixture = await storageFixture();
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory, {
      faultInjector: oneShotFault("artifact_after_temp_write"),
      orphanTtlMs: 0,
    });

    await expect(store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("orphan"),
      "normal",
    )).rejects.toMatchObject({ details: { category: "storage_operation_failed" } });
    expect(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()?.count)
      .toBe(0);
    await expect(store.recover()).resolves.toMatchObject({ orphanFilesDeleted: 1 });
  });

  it("marks missing and mismatched files corrupt during recovery", async () => {
    const fixture = await storageFixture();
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory);
    const first = await store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("first"),
      "normal",
    );
    const second = await store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("second"),
      "normal",
    );
    await rm(path.join(fixture.dataDirectory, ...first.relativePath.split("/")));
    await writeFile(path.join(fixture.dataDirectory, ...second.relativePath.split("/")), "changed");

    await expect(store.recover()).resolves.toMatchObject({ corrupt: 2 });
    expect(artifactState(fixture.database, first.artifactId)).toBe("corrupt");
    expect(artifactState(fixture.database, second.artifactId)).toBe("corrupt");
  });

  it("preserves unknown orphan entries and deletes only owned expired staged files", async () => {
    const fixture = await storageFixture();
    const sessionDirectory = path.join(fixture.dataDirectory, "artifacts", fixture.sessionId);
    await mkdir(sessionDirectory, { recursive: true });
    const artifactId = createStableId();
    const ownedOrphan = path.join(sessionDirectory, `.${artifactId}.${createStableId()}.tmp`);
    const unknownFile = path.join(sessionDirectory, "user-notes.txt");
    await writeFile(ownedOrphan, "expired owned temp");
    await writeFile(unknownFile, "must remain");
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory, { orphanTtlMs: 0 });

    await expect(store.recover()).resolves.toMatchObject({
      orphanFilesDeleted: 1,
      orphanEntriesPreserved: 1,
    });
    await expect(readFile(ownedOrphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unknownFile, "utf8")).resolves.toBe("must remain");
  });

  it("does not return a ready reference when deletion wins the final state CAS", async () => {
    const fixture = await storageFixture();
    let intercepted = false;
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory, {
      stateTransitionBarrier(transition, artifactId, sessionId) {
        if (transition !== "ready" || intercepted) return;
        intercepted = true;
        fixture.database.database.exec("BEGIN IMMEDIATE");
        fixture.database.database
          .prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
          .run(sessionId);
        fixture.database.database
          .prepare("UPDATE artifacts SET state = 'deleting' WHERE artifact_id = ?")
          .run(artifactId);
        fixture.database.database.exec("COMMIT");
      },
    });

    await expect(store.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("deletion wins"),
      "normal",
    )).rejects.toMatchObject({ details: { category: "artifact_commit_conflict" } });
    expect(onlyArtifact(fixture.database).state).toBe("deleting");
  });

  it("does not mark a corrupt ready Artifact after deletion starts", async () => {
    const fixture = await storageFixture();
    const initialStore = new FileArtifactStore(fixture.database, fixture.dataDirectory);
    const reference = await initialStore.write(
      fixture.sessionId,
      "text/plain",
      new TextEncoder().encode("trusted"),
      "normal",
    );
    await writeFile(path.join(fixture.dataDirectory, ...reference.relativePath.split("/")), "changed");
    const store = new FileArtifactStore(fixture.database, fixture.dataDirectory, {
      stateTransitionBarrier(transition, artifactId, sessionId) {
        if (transition !== "corrupt") return;
        fixture.database.database.exec("BEGIN IMMEDIATE");
        fixture.database.database
          .prepare("UPDATE sessions SET deletion_state = 'deleting' WHERE session_id = ?")
          .run(sessionId);
        fixture.database.database
          .prepare("UPDATE artifacts SET state = 'deleting' WHERE artifact_id = ?")
          .run(artifactId);
        fixture.database.database.exec("COMMIT");
      },
    });

    await expect(store.verify(fixture.sessionId, reference)).resolves.toBe(false);
    expect(artifactState(fixture.database, reference.artifactId)).toBe("deleting");
  });
});

async function storageFixture() {
  const directory = await trackedTempDirectory("codeflow-artifacts-");
  const dataDirectory = path.join(directory, "data");
  await mkdir(dataDirectory, { recursive: true });
  const databasePath = path.join(dataDirectory, "codeflow.sqlite");
  const database = openDatabase(databasePath);
  const sessionId = seedSession(database);
  return { database, databasePath, dataDirectory, sessionId };
}

function openDatabase(databasePath: string): SqliteStorageDatabase {
  const database = new SqliteStorageDatabase(databasePath, { clock, busyTimeoutMs: 5 });
  openDatabases.push(database);
  return database;
}

function seedSession(database: SqliteStorageDatabase): string {
  const workspaceId = createStableId();
  const sessionId = createStableId();
  const databaseLocation = database.database.location();
  if (databaseLocation === null) throw new Error("Expected a file-backed test database.");
  const workspacePath = path.resolve(path.dirname(databaseLocation), `workspace-${workspaceId}`);
  database.database.prepare(`
INSERT INTO workspaces(
  workspace_id, schema_version, normalized_path, display_path, fingerprint, created_at
) VALUES (?, 1, ?, ?, ?, ?)`)
    .run(workspaceId, workspacePath, workspacePath, `fingerprint:${workspaceId}`, FIXED_NOW);
  database.database.prepare(`
INSERT INTO sessions(
  session_id, schema_version, workspace_id, goal, pinned,
  created_at, updated_at, expires_at, config_version, tool_catalog_hash, create_bundle_hash,
  last_sequence
) VALUES (?, 1, ?, 'test', 0, ?, ?, NULL, 'config:v1', 'catalog:test', ?, -1)`)
    .run(sessionId, workspaceId, FIXED_NOW, FIXED_NOW, testHash(`bundle:${sessionId}`));
  return sessionId;
}

function testHash(value: string): string {
  return `sha256:${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function oneShotFault(point: StorageFaultPoint) {
  let pending = true;
  return {
    hit(candidate: StorageFaultPoint): void {
      if (pending && candidate === point) {
        pending = false;
        throw new Error(`Injected fault at ${point}`);
      }
    },
  };
}

function onlyArtifact(database: SqliteStorageDatabase): { artifactId: string; state: string } {
  const row = database.database.prepare("SELECT artifact_id, state FROM artifacts").get();
  if (!row || typeof row.artifact_id !== "string" || typeof row.state !== "string") {
    throw new Error("Expected one Artifact row.");
  }
  return { artifactId: row.artifact_id, state: row.state };
}

function artifactState(database: SqliteStorageDatabase, artifactId: string): unknown {
  return database.database
    .prepare("SELECT state FROM artifacts WHERE artifact_id = ?")
    .get(artifactId)?.state;
}

function referenceFromRow(database: SqliteStorageDatabase, artifactId: string): ArtifactReference {
  const row = database.database.prepare(`
SELECT artifact_id, ready_relative_path, media_type, byte_length, sha256, sensitivity
FROM artifacts WHERE artifact_id = ?`).get(artifactId);
  if (!row ||
      typeof row.artifact_id !== "string" ||
      typeof row.ready_relative_path !== "string" ||
      typeof row.media_type !== "string" ||
      typeof row.byte_length !== "number" ||
      typeof row.sha256 !== "string" ||
      (row.sensitivity !== "normal" && row.sensitivity !== "sensitive")) {
    throw new Error("Invalid Artifact row.");
  }
  return {
    artifactId: row.artifact_id,
    relativePath: row.ready_relative_path,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    sensitivity: row.sensitivity,
  };
}

async function trackedTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}
