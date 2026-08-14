import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";

import { stableIdSchema } from "../../shared/contracts.js";
import type {
  ArtifactFileDeleteRequest,
  ArtifactFileDeleter as ArtifactFileDeleterPort,
} from "../session-deletion-service.js";
import type { SqliteStorageDatabase } from "../sqlite/sqlite-database.js";
import { storageError, translateStorageError } from "../sqlite/sqlite-errors.js";

const ARTIFACTS_DIRECTORY = "artifacts";

/**
 * Deletes only FileArtifactStore-owned ready or staged files. Identity is
 * checked from the path before touching the filesystem, then every existing
 * directory/file is resolved to prevent junction or symlink escapes.
 */
export class FileArtifactDeleter implements ArtifactFileDeleterPort {
  readonly #dataDirectory: string;
  readonly #storage: SqliteStorageDatabase;

  constructor(dataDirectory: string, storage: SqliteStorageDatabase) {
    if (!path.isAbsolute(dataDirectory)) {
      throw deletionPathError(
        "artifact_path_invalid",
        "Artifact data directory must be absolute.",
        "Configure an absolute local Artifact data directory.",
      );
    }
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#storage = storage;
  }

  async deleteArtifactFile(
    request: ArtifactFileDeleteRequest,
  ): Promise<"deleted" | "missing"> {
    const sessionId = stableIdSchema.parse(request.sessionId);
    const artifactId = stableIdSchema.parse(request.artifactId);
    const segments = validateOwnedRelativePath(request.relativePath, sessionId, artifactId);
    const candidate = path.resolve(this.#dataDirectory, ...segments);
    if (!isInside(this.#dataDirectory, candidate)) {
      throw outsideBoundaryError(request.relativePath);
    }

    try {
      // Root and both parents are deletion prerequisites. Their absence is not
      // evidence that the requested file is absent: the storage may only be
      // temporarily unavailable, and reporting "missing" would let a Session
      // deletion receipt claim success while bytes remain on the medium.
      const realRoot = await requireTrustedDirectory(
        this.#dataDirectory,
        null,
        "Configured Artifact data directory is unavailable.",
      );
      const artifactsDirectory = path.join(this.#dataDirectory, ARTIFACTS_DIRECTORY);
      const realArtifactsDirectory = await requireTrustedDirectory(
        artifactsDirectory,
        realRoot,
        "Artifact storage root is unavailable.",
      );
      this.#assertBoundRoot(realArtifactsDirectory);
      const sessionDirectory = path.join(artifactsDirectory, sessionId);
      const realSessionDirectory = await requireTrustedDirectory(
        sessionDirectory,
        realArtifactsDirectory,
        `Artifact Session directory ${sessionId} is unavailable.`,
      );

      let information;
      try {
        information = await lstat(candidate);
      } catch (error: unknown) {
        if (isMissing(error)) return "missing";
        throw error;
      }
      if (!information.isFile() || information.isSymbolicLink()) {
        throw deletionPathError(
          "artifact_path_invalid",
          `Artifact deletion target is not a regular file: ${request.relativePath}`,
          "Reject the path and inspect the Artifact data directory.",
        );
      }
      const actual = await realpath(candidate);
      if (!isInside(realRoot, actual) || path.dirname(actual) !== realSessionDirectory) {
        throw outsideBoundaryError(request.relativePath);
      }

      try {
        await rm(candidate, { force: false, recursive: false });
        // Fail closed if a concurrent reparse-point swap changed the trusted
        // parents around the path-based delete. This detects, but cannot make
        // Node's Windows path API handle-relative or fully race-free.
        await assertSameDirectory(this.#dataDirectory, realRoot);
        await assertSameDirectory(artifactsDirectory, realArtifactsDirectory);
        await assertSameDirectory(sessionDirectory, realSessionDirectory);
        return "deleted";
      } catch (error: unknown) {
        if (isMissing(error)) return "missing";
        throw error;
      }
    } catch (error: unknown) {
      if (isStorageError(error)) throw error;
      throw translateStorageError(error);
    }
  }

  async finalizeSessionDirectory(sessionIdInput: string): Promise<"deleted" | "missing"> {
    const sessionId = stableIdSchema.parse(sessionIdInput);
    try {
      const realRoot = await requireTrustedDirectory(
        this.#dataDirectory,
        null,
        "Configured Artifact data directory is unavailable.",
      );
      const artifactsDirectory = path.join(this.#dataDirectory, ARTIFACTS_DIRECTORY);
      const realArtifactsDirectory = await requireTrustedDirectory(
        artifactsDirectory,
        realRoot,
        "Artifact storage root is unavailable.",
      );
      this.#assertBoundRoot(realArtifactsDirectory);
      const sessionDirectory = path.join(artifactsDirectory, sessionId);
      let realSessionDirectory: string;
      try {
        realSessionDirectory = await requireTrustedDirectory(
          sessionDirectory,
          realArtifactsDirectory,
          `Artifact Session directory ${sessionId} is unavailable.`,
        );
      } catch (error: unknown) {
        if (isStorageCategory(error, "artifact_storage_unavailable")) return "missing";
        throw error;
      }

      const unknownEntries: string[] = [];
      for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          unknownEntries.push(entry.name);
          continue;
        }
        const owned = parseOwnedArtifactFileName(entry.name);
        if (!owned) {
          unknownEntries.push(entry.name);
          continue;
        }
        await this.deleteArtifactFile({
          sessionId,
          artifactId: owned.artifactId,
          relativePath: `${ARTIFACTS_DIRECTORY}/${sessionId}/${entry.name}`,
        });
      }
      if (unknownEntries.length > 0) {
        throw deletionPathError(
          "artifact_session_directory_not_empty",
          `Artifact Session directory ${sessionId} contains unknown entries.`,
          "Inspect and safely remove the unknown entries before resuming Session deletion.",
        );
      }
      await assertSameDirectory(sessionDirectory, realSessionDirectory);
      await rmdir(sessionDirectory);
      await assertSameDirectory(this.#dataDirectory, realRoot);
      await assertSameDirectory(artifactsDirectory, realArtifactsDirectory);
      return "deleted";
    } catch (error: unknown) {
      if (isMissing(error)) return "missing";
      if (isStorageError(error)) throw error;
      throw translateStorageError(error);
    }
  }

  #assertBoundRoot(realRoot: string): void {
    const row = this.#storage.database
      .prepare("SELECT artifact_root_fingerprint FROM storage_installation WHERE singleton = 1")
      .get();
    const expected = rootFingerprint(realRoot);
    if (!row || row.artifact_root_fingerprint !== expected) {
      throw deletionPathError(
        "artifact_root_mismatch",
        "Configured Artifact root does not match this storage installation.",
        "Use the Artifact data directory originally bound to this database.",
      );
    }
  }
}

function rootFingerprint(realRoot: string): string {
  const normalized = path.normalize(realRoot).toLowerCase();
  // Kept in sync with FileArtifactStore without exposing the raw local path.
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

async function requireTrustedDirectory(
  directory: string,
  expectedParent: string | null,
  unavailableMessage: string,
): Promise<string> {
  let actual: string;
  try {
    actual = await realpath(directory);
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw deletionPathError(
        "artifact_storage_unavailable",
        unavailableMessage,
        "Restore access to the configured Artifact storage and retry deletion.",
        true,
      );
    }
    throw error;
  }
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    if (information.isSymbolicLink()) throw outsideBoundaryError(directory);
    throw deletionPathError(
      "artifact_path_invalid",
      `Artifact directory is not a regular directory: ${directory}`,
      "Reject the path and inspect the Artifact data directory.",
    );
  }
  if (expectedParent !== null && path.dirname(actual) !== expectedParent) {
    throw outsideBoundaryError(directory);
  }
  return actual;
}

async function assertSameDirectory(directory: string, expected: string): Promise<void> {
  const actual = await requireTrustedDirectory(
    directory,
    path.dirname(expected),
    `Artifact directory became unavailable during deletion: ${directory}`,
  );
  if (actual !== expected) throw outsideBoundaryError(directory);
}

function validateOwnedRelativePath(
  relativePath: string,
  sessionId: string,
  artifactId: string,
): readonly [string, string, string] {
  if (
    typeof relativePath !== "string" || relativePath.length === 0 ||
    relativePath.includes("\0") || relativePath.includes("\\") ||
    path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw outsideBoundaryError(String(relativePath));
  }
  const segments = relativePath.split("/");
  if (
    segments.length !== 3 || segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..") ||
    segments[0] !== ARTIFACTS_DIRECTORY || segments[1] !== sessionId
  ) {
    throw outsideBoundaryError(relativePath);
  }
  const fileName = segments[2]!;
  const readyName = `${artifactId}.bin`;
  if (fileName !== readyName && !isOwnedStagedName(fileName, artifactId)) {
    throw deletionPathError(
      "artifact_identity_mismatch",
      `Artifact path does not match Artifact ${artifactId}: ${relativePath}`,
      "Use only a path persisted for this Session and Artifact identity.",
    );
  }
  return [segments[0]!, segments[1]!, fileName];
}

function isOwnedStagedName(fileName: string, artifactId: string): boolean {
  const prefix = `.${artifactId}.`;
  const suffix = ".tmp";
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return false;
  const nonce = fileName.slice(prefix.length, -suffix.length);
  return stableIdSchema.safeParse(nonce).success;
}

function parseOwnedArtifactFileName(fileName: string): { readonly artifactId: string } | null {
  if (fileName.endsWith(".bin")) {
    const artifactId = fileName.slice(0, -4);
    return stableIdSchema.safeParse(artifactId).success ? { artifactId } : null;
  }
  if (!fileName.startsWith(".") || !fileName.endsWith(".tmp")) return null;
  const body = fileName.slice(1, -4);
  const separator = body.indexOf(".");
  if (separator < 0) return null;
  const artifactId = body.slice(0, separator);
  const nonce = body.slice(separator + 1);
  return stableIdSchema.safeParse(artifactId).success && stableIdSchema.safeParse(nonce).success
    ? { artifactId }
    : null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}

function isStorageError(error: unknown): error is Error {
  return error instanceof Error && error.name === "StorageError";
}

function isStorageCategory(error: unknown, category: string): boolean {
  return typeof error === "object" && error !== null && "details" in error &&
    typeof (error as { readonly details?: unknown }).details === "object" &&
    (error as { readonly details: { readonly category?: unknown } }).details.category === category;
}

function outsideBoundaryError(relativePath: string): Error {
  return deletionPathError(
    "artifact_path_outside_data_dir",
    `Artifact deletion path is outside its configured Session directory: ${relativePath}`,
    "Reject the path and use only FileArtifactStore-issued metadata.",
  );
}

function deletionPathError(
  category: string,
  message: string,
  recovery: string,
  retryable = false,
): Error {
  return storageError(category, message, retryable, recovery);
}
