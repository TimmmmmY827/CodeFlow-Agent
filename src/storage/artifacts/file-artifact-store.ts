import { createHash } from "node:crypto";
import path from "node:path";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
} from "node:fs/promises";

import {
  artifactReferenceSchema,
  createStableId,
  stableIdSchema,
  type ArtifactReference,
  type StructuredError,
} from "../../shared/contracts.js";
import {
  STORAGE_RECORD_SCHEMA_VERSION,
  type ArtifactStore,
  type StorageFaultInjector,
} from "../contracts.js";
import type {
  ArtifactPhysicalState,
  ArtifactRecoveryVerifier,
} from "../storage-recovery-inspector.js";
import {
  SqliteStorageDatabase,
  StorageError,
  translateStorageError,
} from "../sqlite/sqlite-database.js";
import { FileArtifactDeleter } from "./artifact-file-deleter.js";

const ARTIFACTS_DIRECTORY = "artifacts";
const ARTIFACT_EXTENSION = ".bin";

export interface FileArtifactStoreOptions {
  readonly faultInjector?: StorageFaultInjector;
  readonly orphanTtlMs?: number;
  readonly stateTransitionBarrier?: (
    transition: ArtifactStateTransition,
    artifactId: string,
    sessionId: string,
  ) => void | Promise<void>;
}

export type ArtifactStateTransition = "ready" | "corrupt" | "verified";

export interface ArtifactRecoveryReport {
  readonly resumed: number;
  readonly ready: number;
  readonly corrupt: number;
  readonly orphanFilesDeleted: number;
  readonly orphanEntriesPreserved: number;
}

interface ArtifactRow {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly state: "staged" | "ready" | "corrupt" | "deleting";
  readonly stagedRelativePath: string | null;
  readonly readyRelativePath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly sensitivity: "normal" | "sensitive";
}

/**
 * Stores Artifact bytes outside SQLite while keeping their commit state and
 * integrity metadata inside the C02 database.
 */
export class FileArtifactStore implements ArtifactStore, ArtifactRecoveryVerifier {
  readonly #database: SqliteStorageDatabase;
  readonly #dataDirectory: string;
  readonly #faultInjector: StorageFaultInjector | null;
  readonly #orphanTtlMs: number;
  readonly #stateTransitionBarrier: FileArtifactStoreOptions["stateTransitionBarrier"];
  #realDataDirectory: string | null = null;
  #realArtifactsDirectory: string | null = null;

  constructor(
    database: SqliteStorageDatabase,
    dataDirectory: string,
    options: FileArtifactStoreOptions = {},
  ) {
    if (!path.isAbsolute(dataDirectory)) {
      throw artifactError(
        "artifact_path_invalid",
        "Artifact data directory must be an absolute path.",
        false,
        "Configure an absolute local data directory.",
      );
    }
    if (options.orphanTtlMs !== undefined &&
        (!Number.isFinite(options.orphanTtlMs) || options.orphanTtlMs < 0)) {
      throw new RangeError("orphanTtlMs must be a finite nonnegative number.");
    }
    this.#database = database;
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#faultInjector = options.faultInjector ?? null;
    this.#orphanTtlMs = options.orphanTtlMs ?? 24 * 60 * 60 * 1_000;
    this.#stateTransitionBarrier = options.stateTransitionBarrier;
  }

  async write(
    sessionId: string,
    mediaType: string,
    content: Uint8Array,
    sensitivity: ArtifactReference["sensitivity"],
  ): Promise<ArtifactReference> {
    const checkedSessionId = stableIdSchema.parse(sessionId);
    if (typeof mediaType !== "string" || mediaType.trim().length === 0) {
      throw artifactError(
        "artifact_metadata_invalid",
        "Artifact media type must not be empty.",
        false,
        "Provide a valid media type before writing the Artifact.",
      );
    }
    if (!(content instanceof Uint8Array)) {
      throw artifactError(
        "artifact_metadata_invalid",
        "Artifact content must be a Uint8Array.",
        false,
        "Serialize the content to bytes before writing the Artifact.",
      );
    }
    if (sensitivity !== "normal" && sensitivity !== "sensitive") {
      throw artifactError(
        "artifact_metadata_invalid",
        "Artifact sensitivity is invalid.",
        false,
        "Use normal or sensitive Artifact classification.",
      );
    }

    await this.#ensureRoot(true);
    this.#assertSessionAcceptsArtifacts(checkedSessionId);
    const artifactId = createStableId();
    const sessionDirectory = await this.#ensureSessionDirectory(checkedSessionId);

    const temporaryName = `.${artifactId}.${createStableId()}.tmp`;
    const readyName = `${artifactId}${ARTIFACT_EXTENSION}`;
    const stagedRelativePath = toPortableRelativePath(
      path.relative(this.#dataDirectory, path.join(sessionDirectory, temporaryName)),
    );
    const readyRelativePath = toPortableRelativePath(
      path.relative(this.#dataDirectory, path.join(sessionDirectory, readyName)),
    );
    const temporaryPath = await this.#resolveForCreate(stagedRelativePath);
    const readyPath = await this.#resolveForCreate(readyRelativePath);
    const sha256 = digest(content);
    const createdAt = this.#database.clock.utcNow();

    try {
      this.#assertSessionAcceptsArtifacts(checkedSessionId);
      const handle = await open(temporaryPath, "wx");
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#hit("artifact_after_temp_write");

      this.#database.database.exec("BEGIN IMMEDIATE");
      const staged = this.#database.database
        .prepare(`
INSERT INTO artifacts(
  artifact_id, schema_version, session_id, state,
  staged_relative_path, ready_relative_path, media_type, byte_length,
  sha256, sensitivity, created_at, verified_at, error_json
) SELECT ?, ?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, NULL, NULL
FROM sessions WHERE session_id = ? AND deletion_state = 'active'`)
        .run(
          artifactId,
          STORAGE_RECORD_SCHEMA_VERSION,
          checkedSessionId,
          stagedRelativePath,
          readyRelativePath,
          mediaType.trim(),
          content.byteLength,
          sha256,
          sensitivity,
          createdAt,
          checkedSessionId,
        );
      if (staged.changes !== 1) {
        this.#assertSessionAcceptsArtifacts(checkedSessionId);
        throw artifactError(
          "artifact_commit_conflict",
          `Artifact ${artifactId} could not enter staged state.`,
          false,
          "Retry the write only after inspecting the Session and Artifact metadata.",
        );
      }
      this.#database.database.exec("COMMIT");
      await this.#hit("artifact_after_staged");

      await rename(temporaryPath, readyPath);
      await this.#hit("artifact_after_rename");

      const matches = await fileMatches(readyPath, content.byteLength, sha256);
      if (!matches) {
        await this.#beforeStateTransition("corrupt", artifactId, checkedSessionId);
        this.#markCorrupt(
          artifactId,
          checkedSessionId,
          "staged",
          hashMismatchError(artifactId),
        );
        throw artifactError(
          "artifact_hash_mismatch",
          `Artifact ${artifactId} failed its post-rename integrity check.`,
          false,
          "Keep the Artifact blocked and regenerate it from its trusted source.",
        );
      }
      await this.#assertExistingPathInsideDataDirectory(path.dirname(readyPath));
      await this.#beforeStateTransition("ready", artifactId, checkedSessionId);
      this.#markReady(artifactId, checkedSessionId);

      return artifactReferenceSchema.parse({
        artifactId,
        relativePath: readyRelativePath,
        mediaType: mediaType.trim(),
        byteLength: content.byteLength,
        sha256,
        sensitivity,
      });
    } catch (error: unknown) {
      if (this.#database.database.isTransaction) this.#database.database.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }
  }

  async read(sessionId: string, reference: ArtifactReference): Promise<Uint8Array> {
    const checkedSessionId = stableIdSchema.parse(sessionId);
    const checkedReference = parseArtifactReference(reference);
    await this.#ensureRoot(false);
    await this.#assertLexicallyInsideDataDirectory(checkedReference.relativePath);
    const record = this.#getArtifact(checkedReference.artifactId, checkedSessionId);
    this.#assertReferenceMatches(record, checkedReference);
    if (record.state !== "ready") {
      throw artifactError(
        "artifact_not_ready",
        `Artifact ${record.artifactId} is ${record.state}, not ready.`,
        false,
        "Run Artifact recovery or regenerate the evidence before using it.",
      );
    }

    let bytes: Uint8Array;
    try {
      const filePath = await this.#resolveExisting(record.readyRelativePath, record.artifactId);
      bytes = new Uint8Array(await readFile(filePath));
    } catch (error: unknown) {
      if (isFileMissing(error)) {
        await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
        this.#markCorrupt(
          record.artifactId,
          record.sessionId,
          "ready",
          missingFileError(record.artifactId),
        );
        throw artifactError(
          "artifact_missing",
          `Artifact file ${record.artifactId} is missing.`,
          false,
          "Restore or regenerate the Artifact before completing the task.",
        );
      }
      throw translateStorageError(error);
    }
    if (bytes.byteLength !== record.byteLength || digest(bytes) !== record.sha256) {
      await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
      this.#markCorrupt(
        record.artifactId,
        record.sessionId,
        "ready",
        hashMismatchError(record.artifactId),
      );
      throw artifactError(
        "artifact_hash_mismatch",
        `Artifact ${record.artifactId} does not match its stored hash.`,
        false,
        "Keep the Artifact blocked and regenerate it from its trusted source.",
      );
    }
    return bytes;
  }

  async verify(sessionId: string, reference: ArtifactReference): Promise<boolean> {
    const checkedSessionId = stableIdSchema.parse(sessionId);
    const checkedReference = parseArtifactReference(reference);
    await this.#ensureRoot(false);
    await this.#assertLexicallyInsideDataDirectory(checkedReference.relativePath);
    const record = this.#getArtifact(checkedReference.artifactId, checkedSessionId);
    this.#assertReferenceMatches(record, checkedReference);
    if (record.state !== "ready") return false;

    try {
      const filePath = await this.#resolveExisting(record.readyRelativePath, record.artifactId);
      if (!(await fileMatches(filePath, record.byteLength, record.sha256))) {
        await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
        this.#markCorrupt(
          record.artifactId,
          record.sessionId,
          "ready",
          hashMismatchError(record.artifactId),
        );
        return false;
      }
      await this.#beforeStateTransition("verified", record.artifactId, record.sessionId);
      this.#touchVerified(record.artifactId, record.sessionId);
      return true;
    } catch (error: unknown) {
      if (isFileMissing(error)) {
        await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
        this.#markCorrupt(
          record.artifactId,
          record.sessionId,
          "ready",
          missingFileError(record.artifactId),
        );
        return false;
      }
      if (error instanceof StorageError && error.details.category === "artifact_path_outside_data_dir") {
        throw error;
      }
      throw translateStorageError(error);
    }
  }

  async inspect(
    sessionId: Parameters<ArtifactRecoveryVerifier["inspect"]>[0],
    reference: ArtifactReference,
  ): Promise<ArtifactPhysicalState> {
    const checkedSessionId = stableIdSchema.parse(sessionId);
    const checkedReference = parseArtifactReference(reference);
    await this.#ensureRoot(false);
    const record = this.#getArtifact(checkedReference.artifactId, checkedSessionId);
    this.#assertReferenceMatches(record, checkedReference);
    if (record.state !== "ready") return "corrupt";
    try {
      const filePath = await this.#resolveExisting(record.readyRelativePath, record.artifactId);
      return await fileMatches(filePath, record.byteLength, record.sha256) ? "ready" : "corrupt";
    } catch (error: unknown) {
      if (isFileMissing(error)) return "missing";
      throw error;
    }
  }

  /** Reconciles interrupted Artifact commits and removes expired untracked files. */
  async recover(): Promise<ArtifactRecoveryReport> {
    await this.#ensureRoot(true);
    let resumed = 0;
    let ready = 0;
    let corrupt = 0;

    const records = this.#listAllArtifacts();
    for (const record of records) {
      if (record.state === "staged") {
        resumed += 1;
        const outcome = await this.#recoverStaged(record);
        if (outcome === "ready") ready += 1;
        else corrupt += 1;
      } else if (record.state === "ready") {
        try {
          const readyPath = await this.#resolveExisting(record.readyRelativePath, record.artifactId);
          if (!(await fileMatches(readyPath, record.byteLength, record.sha256))) {
            await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
            if (this.#markCorrupt(
              record.artifactId,
              record.sessionId,
              "ready",
              hashMismatchError(record.artifactId),
            )) corrupt += 1;
          }
        } catch (error: unknown) {
          if (isFileMissing(error)) {
            await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
            if (this.#markCorrupt(
              record.artifactId,
              record.sessionId,
              "ready",
              missingFileError(record.artifactId),
            )) corrupt += 1;
          } else {
            throw error;
          }
        }
      }
    }

    const orphanReport = await this.#deleteExpiredOrphans(this.#listAllArtifacts());
    return {
      resumed,
      ready,
      corrupt,
      orphanFilesDeleted: orphanReport.deleted,
      orphanEntriesPreserved: orphanReport.preserved,
    };
  }

  async #recoverStaged(record: ArtifactRow): Promise<"ready" | "corrupt"> {
    try {
      const readyPath = await this.#resolveForCreate(record.readyRelativePath);
      if (!(await pathExists(readyPath))) {
        if (record.stagedRelativePath === null) {
          await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
          this.#markCorrupt(
            record.artifactId,
            record.sessionId,
            "staged",
            missingFileError(record.artifactId),
          );
          return "corrupt";
        }
        const stagedPath = await this.#resolveExisting(record.stagedRelativePath, record.artifactId);
        await rename(stagedPath, readyPath);
      }
      const checkedReadyPath = await this.#resolveExisting(
        record.readyRelativePath,
        record.artifactId,
      );
      if (!(await fileMatches(checkedReadyPath, record.byteLength, record.sha256))) {
        await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
        this.#markCorrupt(
          record.artifactId,
          record.sessionId,
          "staged",
          hashMismatchError(record.artifactId),
        );
        return "corrupt";
      }
      await this.#assertExistingPathInsideDataDirectory(path.dirname(readyPath));
      await this.#beforeStateTransition("ready", record.artifactId, record.sessionId);
      this.#markReady(record.artifactId, record.sessionId);
      return "ready";
    } catch (error: unknown) {
      if (isFileMissing(error)) {
        await this.#beforeStateTransition("corrupt", record.artifactId, record.sessionId);
        this.#markCorrupt(
          record.artifactId,
          record.sessionId,
          "staged",
          missingFileError(record.artifactId),
        );
        return "corrupt";
      }
      throw error;
    }
  }

  async #deleteExpiredOrphans(
    records: readonly ArtifactRow[],
  ): Promise<{ readonly deleted: number; readonly preserved: number }> {
    const referenced = new Set<string>();
    for (const record of records) {
      referenced.add(normalizePortablePath(record.readyRelativePath));
      if (record.stagedRelativePath !== null) {
        referenced.add(normalizePortablePath(record.stagedRelativePath));
      }
    }

    const root = path.join(this.#dataDirectory, ARTIFACTS_DIRECTORY);
    const now = Date.parse(this.#database.clock.utcNow());
    let deleted = 0;
    let preserved = 0;
    const deleter = new FileArtifactDeleter(this.#dataDirectory, this.#database);
    for (const sessionEntry of await readdir(root, { withFileTypes: true })) {
      const checkedSessionId = stableIdSchema.safeParse(sessionEntry.name);
      if (
        !checkedSessionId.success ||
        !sessionEntry.isDirectory() ||
        sessionEntry.isSymbolicLink()
      ) {
        preserved += 1;
        continue;
      }
      const sessionDirectory = path.join(root, sessionEntry.name);
      await this.#assertExistingPathInsideDataDirectory(sessionDirectory);
      for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
        const owned = parseOwnedStagedName(entry.name);
        if (!entry.isFile() || entry.isSymbolicLink() || owned === null) {
          preserved += 1;
          continue;
        }
        const candidate = path.join(sessionDirectory, entry.name);
        const relative = normalizePortablePath(path.relative(this.#dataDirectory, candidate));
        if (referenced.has(relative)) continue;
        const information = await stat(candidate);
        if (this.#orphanTtlMs > 0 && now - information.mtimeMs < this.#orphanTtlMs) continue;
        const outcome = await deleter.deleteArtifactFile({
          sessionId: checkedSessionId.data,
          artifactId: owned.artifactId,
          relativePath: relative,
        });
        if (outcome === "deleted") deleted += 1;
      }
    }
    return { deleted, preserved };
  }

  async #ensureRoot(allowBinding: boolean): Promise<void> {
    if (this.#realDataDirectory === null) {
      this.#realDataDirectory = await realpath(this.#dataDirectory);
    }
    const rootInformation = await lstat(this.#dataDirectory);
    if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
      throw outsideDataDirectoryError(this.#dataDirectory);
    }
    const artifactsDirectory = path.join(this.#dataDirectory, ARTIFACTS_DIRECTORY);
    try {
      await mkdir(artifactsDirectory);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
    }
    const actualArtifactsDirectory = await realpath(artifactsDirectory);
    const artifactsInformation = await lstat(artifactsDirectory);
    if (
      !artifactsInformation.isDirectory() ||
      artifactsInformation.isSymbolicLink() ||
      path.dirname(actualArtifactsDirectory) !== this.#realDataDirectory
    ) {
      throw outsideDataDirectoryError(artifactsDirectory);
    }
    if (
      this.#realArtifactsDirectory !== null &&
      this.#realArtifactsDirectory !== actualArtifactsDirectory
    ) {
      throw outsideDataDirectoryError(artifactsDirectory);
    }
    this.#realArtifactsDirectory = actualArtifactsDirectory;
    this.#bindArtifactRoot(actualArtifactsDirectory, allowBinding);
  }

  #bindArtifactRoot(realRoot: string, allowBinding: boolean): void {
    const fingerprint = digest(path.normalize(realRoot).toLowerCase());
    const observed = this.#database.database
      .prepare("SELECT artifact_root_fingerprint FROM storage_installation WHERE singleton = 1")
      .get();
    if (!observed) {
      throw artifactError(
        "storage_installation_corrupt",
        "Storage installation metadata is missing.",
        false,
        "Stop writes and repair or recreate the storage installation metadata.",
      );
    }
    if (observed.artifact_root_fingerprint !== null) {
      if (observed.artifact_root_fingerprint !== fingerprint) {
        throw artifactError(
          "artifact_root_mismatch",
          "Configured Artifact root does not match this storage installation.",
          false,
          "Use the Artifact data directory originally bound to this database.",
        );
      }
      return;
    }
    if (!allowBinding) {
      throw artifactError(
        "artifact_root_unbound",
        "Artifact root has not been bound by a write or recovery operation.",
        false,
        "Bind the authoritative Artifact root before serving read-only operations.",
      );
    }
    try {
      this.#database.database.exec("BEGIN IMMEDIATE");
      const row = this.#database.database
        .prepare("SELECT artifact_root_fingerprint FROM storage_installation WHERE singleton = 1")
        .get();
      if (!row) {
        throw artifactError(
          "storage_installation_corrupt",
          "Storage installation metadata is missing.",
          false,
          "Stop writes and repair or recreate the storage installation metadata.",
        );
      }
      if (row.artifact_root_fingerprint === null) {
        this.#database.database
          .prepare(`
UPDATE storage_installation SET artifact_root_fingerprint = ?
WHERE singleton = 1 AND artifact_root_fingerprint IS NULL`)
          .run(fingerprint);
      } else if (row.artifact_root_fingerprint !== fingerprint) {
        throw artifactError(
          "artifact_root_mismatch",
          "Configured Artifact root does not match this storage installation.",
          false,
          "Use the Artifact data directory originally bound to this database.",
        );
      }
      this.#database.database.exec("COMMIT");
    } catch (error: unknown) {
      if (this.#database.database.isTransaction) this.#database.database.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw translateStorageError(error);
    }
  }

  async #ensureSessionDirectory(sessionId: string): Promise<string> {
    const artifactsDirectory = path.join(this.#dataDirectory, ARTIFACTS_DIRECTORY);
    await this.#assertExistingPathInsideDataDirectory(artifactsDirectory);
    const sessionDirectory = path.join(artifactsDirectory, sessionId);
    try {
      await mkdir(sessionDirectory);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
    }
    const actual = await realpath(sessionDirectory);
    const information = await lstat(sessionDirectory);
    if (
      !information.isDirectory() ||
      information.isSymbolicLink() ||
      path.dirname(actual) !== this.#realArtifactsDirectory
    ) {
      throw outsideDataDirectoryError(sessionDirectory);
    }
    return sessionDirectory;
  }

  async #assertLexicallyInsideDataDirectory(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
      throw outsideDataDirectoryError(relativePath);
    }
    const segments = relativePath.split(/[\\/]+/u);
    if (segments.some((segment) => segment === ".." || segment.length === 0)) {
      throw outsideDataDirectoryError(relativePath);
    }
    const candidate = path.resolve(this.#dataDirectory, ...segments);
    if (!isPathInside(this.#dataDirectory, candidate)) throw outsideDataDirectoryError(relativePath);
    return candidate;
  }

  async #resolveForCreate(relativePath: string): Promise<string> {
    const candidate = await this.#assertLexicallyInsideDataDirectory(relativePath);
    await this.#assertExistingPathInsideDataDirectory(path.dirname(candidate));
    return candidate;
  }

  async #resolveExisting(relativePath: string, artifactId: string): Promise<string> {
    const candidate = await this.#assertLexicallyInsideDataDirectory(relativePath);
    let actual: string;
    try {
      actual = await realpath(candidate);
    } catch (error: unknown) {
      if (isFileMissing(error)) throw error;
      throw translateStorageError(error);
    }
    if (!isPathInside(this.#realDataDirectory ?? this.#dataDirectory, actual)) {
      throw outsideDataDirectoryError(`${relativePath} (${artifactId})`);
    }
    const information = await lstat(candidate);
    if (!information.isFile()) throw outsideDataDirectoryError(relativePath);
    return candidate;
  }

  async #assertExistingPathInsideDataDirectory(candidate: string): Promise<void> {
    const actual = await realpath(candidate);
    if (!isPathInside(this.#realDataDirectory ?? this.#dataDirectory, actual)) {
      throw outsideDataDirectoryError(candidate);
    }
  }

  #getArtifact(artifactId: string, sessionId: string): ArtifactRow {
    const row = this.#database.database
      .prepare(`
SELECT artifact_id, session_id, state, staged_relative_path, ready_relative_path,
       media_type, byte_length, sha256, sensitivity
FROM artifacts WHERE artifact_id = ? AND session_id = ?`)
      .get(artifactId, sessionId);
    if (!row) {
      throw artifactError(
        "artifact_not_found",
        `Artifact ${artifactId} does not belong to Session ${sessionId}.`,
        false,
        "Use an Artifact reference issued for the current Session.",
      );
    }
    return parseArtifactRow(row);
  }

  #assertSessionAcceptsArtifacts(sessionId: string): void {
    const row = this.#database.database
      .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
      .get(sessionId);
    if (!row) {
      throw artifactError(
        "session_not_found",
        `Session ${sessionId} does not exist.`,
        false,
        "Create the Session before writing an Artifact.",
      );
    }
    if (row.deletion_state !== "active") {
      throw artifactError(
        "session_deleting",
        `Session ${sessionId} is being deleted and cannot accept new Artifacts.`,
        false,
        "Wait for deletion to finish or create a new Session.",
      );
    }
  }

  #listAllArtifacts(): ArtifactRow[] {
    return this.#database.database
      .prepare(`
SELECT artifact_id, session_id, state, staged_relative_path, ready_relative_path,
       media_type, byte_length, sha256, sensitivity
FROM artifacts ORDER BY artifact_id`)
      .all()
      .map(parseArtifactRow);
  }

  #assertReferenceMatches(record: ArtifactRow, reference: ArtifactReference): void {
    if (
      normalizePortablePath(reference.relativePath) !== normalizePortablePath(record.readyRelativePath) ||
      reference.mediaType !== record.mediaType ||
      reference.byteLength !== record.byteLength ||
      reference.sha256 !== record.sha256 ||
      reference.sensitivity !== record.sensitivity
    ) {
      throw artifactError(
        "artifact_reference_mismatch",
        `Artifact reference ${reference.artifactId} does not match durable metadata.`,
        false,
        "Reload the durable Artifact reference instead of trusting caller-provided metadata.",
      );
    }
  }

  #markReady(artifactId: string, sessionId: string): void {
    const result = this.#database.database
      .prepare(`
UPDATE artifacts
SET state = 'ready', staged_relative_path = NULL, verified_at = ?, error_json = NULL
WHERE artifact_id = ? AND session_id = ? AND state = 'staged'
  AND EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.session_id = artifacts.session_id
      AND sessions.deletion_state = 'active'
  )`)
      .run(this.#database.clock.utcNow(), artifactId, sessionId);
    if (result.changes !== 1) throw artifactCommitConflict(artifactId, sessionId);
  }

  #markCorrupt(
    artifactId: string,
    sessionId: string,
    expectedState: "staged" | "ready",
    error: StructuredError,
  ): boolean {
    const result = this.#database.database
      .prepare(`
UPDATE artifacts SET state = 'corrupt', error_json = ?
WHERE artifact_id = ? AND session_id = ? AND state = ?
  AND EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.session_id = artifacts.session_id
      AND sessions.deletion_state = 'active'
  )`)
      .run(JSON.stringify(error), artifactId, sessionId, expectedState);
    return result.changes === 1;
  }

  #touchVerified(artifactId: string, sessionId: string): void {
    const result = this.#database.database
      .prepare(`
UPDATE artifacts SET verified_at = ?
WHERE artifact_id = ? AND session_id = ? AND state = 'ready'
  AND EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.session_id = artifacts.session_id
      AND sessions.deletion_state = 'active'
  )`)
      .run(this.#database.clock.utcNow(), artifactId, sessionId);
    if (result.changes !== 1) throw artifactCommitConflict(artifactId, sessionId);
  }

  async #hit(point: Parameters<StorageFaultInjector["hit"]>[0]): Promise<void> {
    await this.#faultInjector?.hit(point);
  }

  async #beforeStateTransition(
    transition: ArtifactStateTransition,
    artifactId: string,
    sessionId: string,
  ): Promise<void> {
    await this.#stateTransitionBarrier?.(transition, artifactId, sessionId);
  }

}

function parseArtifactRow(row: Record<string, unknown>): ArtifactRow {
  const state = row.state;
  const sensitivity = row.sensitivity;
  if (
    typeof row.artifact_id !== "string" ||
    typeof row.session_id !== "string" ||
    (state !== "staged" && state !== "ready" && state !== "corrupt" && state !== "deleting") ||
    (row.staged_relative_path !== null && typeof row.staged_relative_path !== "string") ||
    typeof row.ready_relative_path !== "string" ||
    typeof row.media_type !== "string" ||
    typeof row.byte_length !== "number" ||
    !Number.isSafeInteger(row.byte_length) ||
    typeof row.sha256 !== "string" ||
    (sensitivity !== "normal" && sensitivity !== "sensitive")
  ) {
    throw artifactError(
      "storage_corrupt",
      "Artifact metadata row is invalid.",
      false,
      "Stop writes and inspect the storage database.",
    );
  }
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    state,
    stagedRelativePath: row.staged_relative_path,
    readyRelativePath: row.ready_relative_path,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    sensitivity,
  };
}

async function fileMatches(filePath: string, byteLength: number, expectedHash: string): Promise<boolean> {
  const information = await stat(filePath);
  if (!information.isFile() || information.size !== byteLength) return false;
  return digest(new Uint8Array(await readFile(filePath))) === expectedHash;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error: unknown) {
    if (isFileMissing(error)) return false;
    throw error;
  }
}

function parseOwnedStagedName(
  fileName: string,
): { readonly artifactId: string; readonly nonce: string } | null {
  if (!fileName.startsWith(".") || !fileName.endsWith(".tmp")) return null;
  const body = fileName.slice(1, -4);
  const separator = body.indexOf(".");
  if (separator < 0) return null;
  const artifactId = body.slice(0, separator);
  const nonce = body.slice(separator + 1);
  if (!stableIdSchema.safeParse(artifactId).success || !stableIdSchema.safeParse(nonce).success) {
    return null;
  }
  return { artifactId, nonce };
}

function digest(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toPortableRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizePortablePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function parseArtifactReference(reference: ArtifactReference): ArtifactReference {
  const parsed = artifactReferenceSchema.safeParse(reference);
  if (!parsed.success) {
    throw artifactError(
      "artifact_metadata_invalid",
      "Artifact reference metadata is invalid.",
      false,
      "Use a complete Artifact reference issued by the ArtifactStore.",
    );
  }
  return parsed.data;
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}

function outsideDataDirectoryError(candidate: string): StorageError {
  return artifactError(
    "artifact_path_outside_data_dir",
    `Artifact path is outside the configured data directory: ${candidate}`,
    false,
    "Reject the reference and use only paths issued by the ArtifactStore.",
  );
}

function missingFileError(artifactId: string): StructuredError {
  return {
    category: "artifact_missing",
    message: `Artifact file ${artifactId} is missing.`,
    retryable: false,
    sideEffectStatus: "none",
    recovery: "Restore or regenerate the Artifact before completing the task.",
  };
}

function hashMismatchError(artifactId: string): StructuredError {
  return {
    category: "artifact_hash_mismatch",
    message: `Artifact ${artifactId} does not match its stored hash.`,
    retryable: false,
    sideEffectStatus: "none",
    recovery: "Keep the Artifact blocked and regenerate it from its trusted source.",
  };
}

function artifactError(
  category: string,
  message: string,
  retryable: boolean,
  recovery: string,
): StorageError {
  return new StorageError({
    category,
    message,
    retryable,
    sideEffectStatus: "none",
    recovery,
  });
}

function artifactCommitConflict(artifactId: string, sessionId: string): StorageError {
  return artifactError(
    "artifact_commit_conflict",
    `Artifact ${artifactId} cannot transition because Session ${sessionId} or its state changed.`,
    false,
    "Treat the operation as unsuccessful; deletion or another state transition won.",
  );
}
