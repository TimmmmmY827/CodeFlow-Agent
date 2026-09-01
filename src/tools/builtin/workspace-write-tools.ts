import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { z } from "zod";

import { systemClock, type StructuredError } from "../../shared/contracts.js";
import { canonicalJson } from "../../shared/json.js";
import type {
  AnyToolDefinition,
  NormalizedToolInput,
  ResourceClaim,
  ToolDefinition,
  ToolExecutionContext,
} from "../tool.js";
import { ToolExecutionError } from "../tool.js";
import type { ToolRegistry } from "../tool-registry.js";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const relativePathSchema = z.string().trim().min(1).max(1_024).superRefine((value, refinement) => {
  if (isAbsolute(value) || value.includes("\0")) {
    refinement.addIssue({ code: "custom", message: "Path must be a relative workspace path." });
  }
});

const fileVersionSchema = z.object({
  path: relativePathSchema,
  sha256: digestSchema.nullable(),
}).strict();

const fileChangeSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["created", "modified"]),
  beforeSha256: digestSchema.nullable(),
  afterSha256: digestSchema,
}).strict();

const applyPatchInputSchema = z.object({
  patch: z.string().min(1).max(1_000_000),
  expectedCodeVersion: z.string().trim().min(1).max(256),
  expectedFiles: z.array(fileVersionSchema).min(1).max(100),
}).strict();

const applyPatchOutputSchema = z.object({
  changedFiles: z.array(fileChangeSchema).min(1),
  newCodeVersion: z.string().min(1),
  diffHash: digestSchema,
}).strict();

const writeFileInputSchema = z.object({
  path: relativePathSchema,
  content: z.string().max(2_000_000),
  mode: z.enum(["create", "replace"]),
  expectedSha256: digestSchema.nullable(),
}).strict().superRefine((value, refinement) => {
  if (value.mode === "create" && value.expectedSha256 !== null) {
    refinement.addIssue({ code: "custom", path: ["expectedSha256"], message: "create requires a null expectedSha256." });
  }
  if (value.mode === "replace" && value.expectedSha256 === null) {
    refinement.addIssue({ code: "custom", path: ["expectedSha256"], message: "replace requires an expectedSha256." });
  }
});

const writeFileOutputSchema = z.object({
  path: z.string().min(1),
  beforeSha256: digestSchema.nullable(),
  afterSha256: digestSchema,
}).strict();

const runCommandInputSchema = z.object({
  executable: z.string().trim().min(1).max(128),
  args: z.array(z.string().max(4_096)).max(128).optional().default([]),
  cwd: relativePathSchema.optional().default("."),
  timeoutMs: z.number().int().min(100).max(120_000).optional().default(30_000),
  env: z.record(z.string(), z.string().max(4_096)).optional().default({}),
  purpose: z.string().trim().min(1).max(512),
}).strict();

const runCommandOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.literal(false),
}).strict();

const WRITE_DENIED_DIRECTORIES = new Set([".git", ".codeflow", "artifacts", "node_modules"]);
const COMMAND_ENVIRONMENT_KEYS = new Set([
  "CI",
  "FORCE_COLOR",
  "NODE_ENV",
  "NO_COLOR",
  "PYTHONUTF8",
  "RUST_BACKTRACE",
]);
const BASE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "USERPROFILE",
]);
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;

type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;
type ApplyPatchOutput = z.infer<typeof applyPatchOutputSchema>;
type WriteFileInput = z.infer<typeof writeFileInputSchema>;
type WriteFileOutput = z.infer<typeof writeFileOutputSchema>;
type RunCommandInput = z.infer<typeof runCommandInputSchema>;
type RunCommandOutput = z.infer<typeof runCommandOutputSchema>;

export function createWorkspaceWriteTools(): readonly AnyToolDefinition[] {
  return [createApplyPatchTool(), createWriteFileTool(), createRunCommandTool()];
}

export function registerWorkspaceWriteTools(registry: ToolRegistry): void {
  for (const tool of createWorkspaceWriteTools()) registry.register(tool);
}

export function createApplyPatchTool(): ToolDefinition<ApplyPatchInput, ApplyPatchOutput> {
  return writeTool(
    "apply_patch",
    "Apply one atomic unified patch after verifying the Git and file versions.",
    applyPatchInputSchema,
    applyPatchOutputSchema,
    normalizeApplyPatchInput,
    (input) => workspaceWriteClaims(input.expectedFiles.map((file) => file.path)),
    async (input, context) => {
      const root = await requireWorkspaceRoot(context.workspace);
      const patchTargets = parsePatchTargets(input.patch);
      const patchPaths = patchTargets.map((target) => target.path);
      const expected = new Map(input.expectedFiles.map((file) => [file.path, file.sha256]));
      assertExactPathSet(patchPaths, expected);
      assertPatchTargetVersions(patchTargets, expected);
      const codeVersion = await currentCodeVersion(root, context);
      if (input.expectedCodeVersion !== context.codeVersion || input.expectedCodeVersion !== codeVersion) {
        throw toolError(
          "code_version_conflict",
          "The workspace Git version changed after the patch was prepared.",
          true,
          "not_started",
        );
      }
      const before = await readExpectedVersions(root, expected);
      const statusBefore = await currentGitStatusPaths(root, context, "not_started");
      await runGitApply(root, context, input.patch, true);
      await assertExpectedVersions(root, expected);
      await runGitApply(root, context, input.patch, false);

      try {
        const statusAfter = await currentGitStatusPaths(root, context, "unknown");
        assertNoUnexpectedStatusPaths(statusBefore, statusAfter, new Set(patchPaths));
        const changedFiles = [];
        for (const path of patchPaths) {
          const target = await resolveWriteTarget(root, path, true);
          const afterSha256 = digestBytes(await readFile(target.candidate));
          changedFiles.push({
            path,
            kind: before.get(path) === null ? "created" as const : "modified" as const,
            beforeSha256: before.get(path) ?? null,
            afterSha256,
          });
        }
        return {
          changedFiles,
          newCodeVersion: await currentCodeVersion(root, context),
          diffHash: await currentDiffHash(root, context),
        };
      } catch (error: unknown) {
        throw unknownAfterWrite(error, "patch_verification_failed", "The applied patch could not be verified safely.");
      }
    },
  );
}

export function createWriteFileTool(): ToolDefinition<WriteFileInput, WriteFileOutput> {
  return writeTool(
    "write_file",
    "Atomically create or replace one UTF-8 workspace file with compare-and-swap evidence.",
    writeFileInputSchema,
    writeFileOutputSchema,
    normalizePathInput,
    (input) => workspaceWriteClaims([input.path]),
    async (input, context) => {
      const root = await requireWorkspaceRoot(context.workspace);
      const target = await resolveWriteTarget(root, input.path, input.mode === "replace");
      const bytes = Buffer.from(input.content, "utf8");
      let beforeSha256: string | null = null;
      if (input.mode === "create") {
        if (await pathExists(target.candidate)) {
          throw toolError("file_already_exists", "create cannot replace an existing path.", false, "not_started");
        }
      } else {
        beforeSha256 = digestBytes(await readRegularFile(target.candidate));
        if (beforeSha256 !== input.expectedSha256) {
          throw toolError("file_version_conflict", "The file changed after its expected hash was captured.", true, "not_started");
        }
      }

      const temporary = resolve(target.parent, `.${basename(target.candidate)}.${randomUUID()}.tmp`);
      try {
        const mode = input.mode === "replace" ? (await stat(target.candidate)).mode : 0o600;
        const handle = await open(temporary, "wx", mode);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        assertActive(context, "not_started");
        if (input.mode === "create") {
          await link(temporary, target.candidate).catch((error: unknown) => {
            if (isNodeError(error, "EEXIST")) {
              throw toolError("file_already_exists", "The target appeared while create was committing.", true, "not_started");
            }
            throw error;
          });
        } else {
          const currentSha256 = digestBytes(await readRegularFile(target.candidate));
          if (currentSha256 !== input.expectedSha256) {
            throw toolError("file_version_conflict", "The file changed while replacement was committing.", true, "not_started");
          }
          await rename(temporary, target.candidate);
        }
      } catch (error: unknown) {
        await unlink(temporary).catch(() => undefined);
        if (error instanceof ToolExecutionError) throw error;
        throw toolError(
          "file_write_failed",
          error instanceof Error ? error.message : "The file write failed.",
          false,
          "unknown",
        );
      } finally {
        await unlink(temporary).catch(() => undefined);
      }

      try {
        const committed = await resolveWriteTarget(root, input.path, true);
        const afterSha256 = digestBytes(await readRegularFile(committed.candidate));
        if (afterSha256 !== digestBytes(bytes)) {
          throw toolError("file_commit_unverified", "The committed file does not match the requested bytes.", false, "unknown");
        }
        return { path: input.path, beforeSha256, afterSha256 };
      } catch (error: unknown) {
        throw unknownAfterWrite(error, "file_commit_unverified", "The committed file could not be verified safely.");
      }
    },
  );
}

export function createRunCommandTool(): ToolDefinition<RunCommandInput, RunCommandOutput> {
  return writeTool(
    "run_command",
    "Run one allowlisted executable in a bounded workspace directory; Windows package shims use a hardened cmd bridge.",
    runCommandInputSchema,
    runCommandOutputSchema,
    normalizeCommandInput,
    () => workspaceWriteClaims([]),
    async (input, context) => {
      const root = await requireWorkspaceRoot(context.workspace);
      const workingDirectory = await resolveWriteTarget(root, input.cwd, true, true);
      const command = await validateCommand(root, input, workingDirectory.candidate);
      const environment = commandEnvironment(input.env);
      const startedAt = performance.now();
      const result = await runProcess({
        command: command.executable,
        args: command.args,
        cwd: workingDirectory.candidate,
        environment,
        context,
        timeoutMs: input.timeoutMs,
        stdin: null,
        sideEffectStatusAfterStart: "unknown",
        windowsVerbatimArguments: command.windowsVerbatimArguments ?? false,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        timedOut: false,
      };
    },
  );
}

function writeTool<TInput, TOutput>(
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  normalizeInput: (input: TInput) => NormalizedToolInput<TInput>,
  claimResources: (input: TInput) => readonly ResourceClaim[],
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>,
): ToolDefinition<TInput, TOutput> {
  return {
    name,
    version: `tool:${name}@1.0.0`,
    normalizationVersion: "normalization:workspace-write-v1",
    description,
    risk: "task_authorized",
    sideEffect: "workspace_write",
    retryPolicy: "never",
    inputSchema,
    outputSchema,
    availability: { available: true, reasonCode: null, message: null, checkedAt: systemClock.utcNow() },
    normalizeInput,
    claimResources,
    execute,
  };
}

function normalizePathInput<TInput extends { readonly path: string }>(input: TInput): NormalizedToolInput<TInput> {
  const path = canonicalRelativePath(input.path);
  return {
    effectiveInput: { ...input, path },
    transformations: path === input.path ? [] : [pathTransformation("/path", input.path, path)],
  };
}

function normalizeApplyPatchInput(input: ApplyPatchInput): NormalizedToolInput<ApplyPatchInput> {
  const expectedFiles = input.expectedFiles
    .map((file) => ({ ...file, path: canonicalRelativePath(file.path) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const changed = canonicalJson(expectedFiles) !== canonicalJson(input.expectedFiles);
  return {
    effectiveInput: { ...input, expectedFiles },
    transformations: changed
      ? [pathTransformation("/expectedFiles", input.expectedFiles, expectedFiles)]
      : [],
  };
}

function normalizeCommandInput(input: RunCommandInput): NormalizedToolInput<RunCommandInput> {
  const cwd = canonicalRelativePath(input.cwd);
  return {
    effectiveInput: { ...input, cwd },
    transformations: cwd === input.cwd ? [] : [pathTransformation("/cwd", input.cwd, cwd)],
  };
}

function canonicalRelativePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/") || ".";
}

function pathTransformation(field: string, before: unknown, after: unknown) {
  return {
    field,
    ruleCode: "normalize_workspace_write_v1",
    beforeHash: digestCanonical(before),
    afterHash: digestCanonical(after),
  } as const;
}

function pathClaim(path: string): ResourceClaim {
  return { key: `path:${path}`, mode: "write", scope: "path" };
}

function workspaceWriteClaims(paths: readonly string[]): readonly ResourceClaim[] {
  return [
    { key: "workspace:current", mode: "write", scope: "workspace" },
    ...paths.map(pathClaim),
  ];
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function requireWorkspaceRoot(workspace: string): Promise<string> {
  const root = await realpath(workspace).catch(() => {
    throw toolError("workspace_unavailable", "The workspace root is unavailable.", true, "not_started");
  });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw toolError("workspace_unavailable", "The workspace root is not a trusted directory.", false, "not_started");
  }
  return root;
}

async function resolveWriteTarget(
  root: string,
  requested: string,
  mustExist: boolean,
  allowDirectory = false,
): Promise<{ root: string; parent: string; candidate: string }> {
  const candidate = resolve(root, requested);
  assertContained(root, candidate);
  const normalized = normalizeRelative(root, candidate);
  assertAllowedWritePath(normalized);
  await assertNoLinkTraversal(root, candidate, !mustExist);
  const parentCandidate = relative(root, candidate) === "" ? root : dirname(candidate);
  const parent = await realpath(parentCandidate).catch(() => {
    throw toolError("path_parent_not_found", "The target parent directory does not exist.", false, "not_started");
  });
  assertContained(root, parent);
  assertResolvedPathIdentity(root, parentCandidate, parent);
  assertAllowedWritePath(normalizeRelative(root, parent));
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw toolError("workspace_link_rejected", "Write paths cannot traverse links or junctions.", false, "not_started");
  }
  if (!mustExist) return { root, parent, candidate };
  const resolvedCandidate = await realpath(candidate).catch(() => {
    throw toolError("path_not_found", "The requested workspace path does not exist.", false, "not_started");
  });
  assertContained(root, resolvedCandidate);
  assertResolvedPathIdentity(root, candidate, resolvedCandidate);
  assertAllowedWritePath(normalizeRelative(root, resolvedCandidate));
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw toolError("workspace_link_rejected", "Write paths cannot target links or junctions.", false, "not_started");
  }
  if (allowDirectory ? !metadata.isDirectory() : !metadata.isFile()) {
    throw toolError(allowDirectory ? "not_a_directory" : "not_a_file", "The requested path has the wrong file type.", false, "not_started");
  }
  return { root, parent, candidate: resolvedCandidate };
}

function assertAllowedWritePath(path: string): void {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => WRITE_DENIED_DIRECTORIES.has(caseFold(segment)))) {
    throw toolError("path_ignored", "The target path is reserved or generated content.", false, "not_started");
  }
}

function assertResolvedPathIdentity(root: string, requested: string, resolvedPath: string): void {
  const requestedRelative = caseFold(normalizeRelative(root, requested));
  const resolvedRelative = caseFold(normalizeRelative(root, resolvedPath));
  if (requestedRelative !== resolvedRelative) {
    throw toolError(
      "workspace_alias_rejected",
      "Write paths must use their canonical long names and casing; filesystem aliases are rejected.",
      false,
      "not_started",
    );
  }
}

async function assertNoLinkTraversal(root: string, candidate: string, skipTarget: boolean): Promise<void> {
  const relativePath = relative(root, candidate);
  const segments = relativePath.split(sep).filter(Boolean);
  const checkedSegments = skipTarget ? segments.slice(0, -1) : segments;
  let current = root;
  for (const segment of checkedSegments) {
    current = resolve(current, segment);
    const metadata = await lstat(current).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        throw toolError("path_parent_not_found", "The target parent directory does not exist.", false, "not_started");
      }
      throw error;
    });
    if (metadata.isSymbolicLink()) {
      throw toolError("workspace_link_rejected", "Write paths cannot traverse links or junctions.", false, "not_started");
    }
  }
}

function assertContained(root: string, candidate: string): void {
  const value = relative(root, candidate);
  if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))) return;
  throw toolError("workspace_boundary_violation", "The requested path escapes the workspace boundary.", false, "not_started");
}

function normalizeRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/") || ".";
}

function caseFold(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function readRegularFile(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw toolError("not_a_file", "The target is not a regular file.", false, "not_started");
  }
  return await readFile(path);
}

interface PatchTarget {
  readonly path: string;
  readonly source: "existing" | "new";
}

function parsePatchTargets(patch: string): readonly PatchTarget[] {
  if (patch.includes("GIT binary patch") || /^Binary files /mu.test(patch)) {
    throw toolError("patch_binary_unsupported", "Binary patches are not supported.", false, "not_started");
  }
  if (/^(rename|copy) (from|to) /mu.test(patch)) {
    throw toolError("patch_rename_unsupported", "Patch rename and copy records are not supported.", false, "not_started");
  }
  const targets: PatchTarget[] = [];
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/u.exec(line);
    if (!match || match[1] !== match[2]) {
      throw toolError("patch_path_unsupported", "Patch paths must be unquoted and cannot rename files.", false, "not_started");
    }
    const path = canonicalRelativePath(match[1] ?? "");
    if (path !== match[1] || path === ".") {
      throw toolError("patch_path_invalid", "Patch paths must already be canonical workspace-relative paths.", false, "not_started");
    }
    const blockEnd = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.startsWith("diff --git "));
    const block = lines.slice(index, blockEnd === -1 ? lines.length : blockEnd).join("\n");
    const hunkOffset = block.indexOf("\n@@");
    if (hunkOffset < 0) {
      throw toolError("patch_header_invalid", "Each patch block requires at least one unified diff hunk.", false, "not_started");
    }
    const header = block.slice(0, hunkOffset);
    const preimages = [...header.matchAll(/^--- (.+)$/gmu)].map((item) => item[1] ?? "");
    const postimages = [...header.matchAll(/^\+\+\+ (.+)$/gmu)].map((item) => item[1] ?? "");
    if (preimages.length !== 1 || postimages.length !== 1) {
      throw toolError("patch_header_invalid", "Each patch block requires exactly one preimage and postimage header.", false, "not_started");
    }
    if (postimages[0] === "/dev/null") {
      throw toolError("patch_delete_requires_approval", "File deletion must use the separately approved delete tool.", false, "not_started");
    }
    if (postimages[0] !== `b/${path}`) {
      throw toolError("patch_header_invalid", "Each patch block requires a matching target header.", false, "not_started");
    }
    const preimage = preimages[0];
    if (preimage !== "/dev/null" && preimage !== `a/${path}`) {
      throw toolError(
        "patch_preimage_mismatch",
        "A patch preimage must match its declared target; implicit rename and disclosure patches are rejected.",
        false,
        "not_started",
      );
    }
    targets.push({ path, source: preimage === "/dev/null" ? "new" : "existing" });
  }
  const paths = targets.map((target) => target.path);
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw toolError("patch_invalid", "The patch must contain unique unified diff blocks.", false, "not_started");
  }
  return targets;
}

function assertExactPathSet(paths: readonly string[], expected: ReadonlyMap<string, string | null>): void {
  if (paths.length !== expected.size || paths.some((path) => !expected.has(path))) {
    throw toolError(
      "patch_expected_files_mismatch",
      "expectedFiles must describe every patch target exactly once.",
      false,
      "not_started",
    );
  }
}

function assertPatchTargetVersions(
  targets: readonly PatchTarget[],
  expected: ReadonlyMap<string, string | null>,
): void {
  for (const target of targets) {
    const expectedSha256 = expected.get(target.path);
    if ((target.source === "new") !== (expectedSha256 === null)) {
      throw toolError(
        "patch_preimage_version_mismatch",
        "New-file patch headers and expected null file versions must agree.",
        false,
        "not_started",
      );
    }
  }
}

async function currentGitStatusPaths(
  root: string,
  context: ToolExecutionContext,
  sideEffectStatus: StructuredError["sideEffectStatus"],
): Promise<ReadonlySet<string>> {
  const result = await runProcess({
    command: "git",
    args: ["--no-optional-locks", "-c", "status.relativePaths=true", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "./"],
    cwd: root,
    environment: gitEnvironment(),
    context,
    timeoutMs: 10_000,
    stdin: null,
    sideEffectStatusAfterStart: sideEffectStatus,
  });
  if (result.exitCode !== 0) {
    throw toolError("git_snapshot_failed", "The workspace Git status could not be captured.", false, sideEffectStatus);
  }
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw toolError("git_snapshot_truncated", "The workspace Git status exceeded its verification limit.", false, sideEffectStatus);
  }
  const paths = new Set<string>();
  const records = result.stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw toolError("git_snapshot_invalid", "Git returned an invalid status record.", false, sideEffectStatus);
    }
    const status = record.slice(0, 2);
    const path = record.slice(3).replaceAll("\\", "/");
    paths.add(path);
    if (/[RC]/u.test(status)) {
      const source = records[index + 1];
      if (!source) throw toolError("git_snapshot_invalid", "Git returned an incomplete rename record.", false, sideEffectStatus);
      paths.add(source.replaceAll("\\", "/"));
      index += 1;
    }
  }
  return paths;
}

function assertNoUnexpectedStatusPaths(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  declared: ReadonlySet<string>,
): void {
  for (const path of after) {
    if (!before.has(path) && !declared.has(path)) {
      throw toolError(
        "patch_change_set_unverified",
        "The patch changed an undeclared Git path; its side effects require inspection.",
        false,
        "unknown",
      );
    }
  }
}

async function readExpectedVersions(
  root: string,
  expected: ReadonlyMap<string, string | null>,
): Promise<Map<string, string | null>> {
  const versions = new Map<string, string | null>();
  for (const [path, expectedSha256] of expected) {
    if (expectedSha256 === null) {
      const target = await resolveWriteTarget(root, path, false);
      if (await pathExists(target.candidate)) {
        throw toolError("file_version_conflict", `Expected ${path} not to exist.`, true, "not_started");
      }
      versions.set(path, null);
      continue;
    }
    const target = await resolveWriteTarget(root, path, true);
    const current = digestBytes(await readRegularFile(target.candidate));
    if (current !== expectedSha256) {
      throw toolError("file_version_conflict", `The expected hash for ${path} no longer matches.`, true, "not_started");
    }
    versions.set(path, current);
  }
  return versions;
}

async function assertExpectedVersions(root: string, expected: ReadonlyMap<string, string | null>): Promise<void> {
  await readExpectedVersions(root, expected);
}

async function currentCodeVersion(root: string, context: ToolExecutionContext): Promise<string> {
  const result = await runProcess({
    command: "git",
    args: ["--no-optional-locks", "rev-parse", "--verify", "HEAD"],
    cwd: root,
    environment: gitEnvironment(),
    context,
    timeoutMs: 10_000,
    stdin: null,
    sideEffectStatusAfterStart: "not_started",
  });
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(result.stdout.trim())) {
    throw toolError("not_a_git_repository", "apply_patch requires a Git workspace with a valid HEAD.", false, "not_started");
  }
  return `git:${result.stdout.trim()}`;
}

async function currentDiffHash(root: string, context: ToolExecutionContext): Promise<string> {
  const status = await runGitRead(root, context, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "./"]);
  const diff = await runGitRead(root, context, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", "./"]);
  return digestBytes(Buffer.from(`${status}\0${diff}`, "utf8"));
}

async function runGitRead(root: string, context: ToolExecutionContext, args: readonly string[]): Promise<string> {
  const result = await runProcess({
    command: "git",
    args: ["--no-optional-locks", ...args],
    cwd: root,
    environment: gitEnvironment(),
    context,
    timeoutMs: 10_000,
    stdin: null,
    sideEffectStatusAfterStart: "not_started",
  });
  if (result.exitCode !== 0) {
    throw toolError("git_snapshot_failed", "The workspace Git snapshot could not be captured.", true, "unknown");
  }
  return result.stdout;
}

async function runGitApply(
  root: string,
  context: ToolExecutionContext,
  patch: string,
  check: boolean,
): Promise<void> {
  const result = await runProcess({
    command: "git",
    args: ["--no-optional-locks", "apply", ...(check ? ["--check"] : []), "--whitespace=nowarn", "--recount"],
    cwd: root,
    environment: gitEnvironment(),
    context,
    timeoutMs: 10_000,
    stdin: patch,
    sideEffectStatusAfterStart: check ? "not_started" : "unknown",
  });
  if (result.exitCode !== 0) {
    throw toolError(
      check ? "patch_check_failed" : "patch_apply_failed",
      check ? "The patch cannot be applied cleanly." : "Git could not confirm that the patch was applied atomically.",
      false,
      check ? "not_started" : "unknown",
    );
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = baseEnvironment();
  environment.GIT_LITERAL_PATHSPECS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function baseEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && BASE_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
  }
  return environment;
}

function commandEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment = baseEnvironment();
  for (const [key, value] of Object.entries(overrides)) {
    const normalized = key.toUpperCase();
    if (!COMMAND_ENVIRONMENT_KEYS.has(normalized) || /[\u0000\r\n]/u.test(value)) {
      throw toolError("command_environment_denied", `Environment override ${key} is not allowed.`, false, "not_started");
    }
    environment[normalized] = value;
  }
  return environment;
}

interface ValidatedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

async function validateCommand(root: string, input: RunCommandInput, cwd: string): Promise<ValidatedCommand> {
  if (/[\\/]/u.test(input.executable) || input.executable.startsWith(".")) {
    throw toolError("command_executable_denied", "Executable paths are not accepted.", false, "not_started");
  }
  if (input.args.some((argument) => argument.includes("\0"))) {
    throw toolError("command_argument_invalid", "Command arguments cannot contain NUL bytes.", false, "not_started");
  }
  assertNoExternalPathArguments(input.args);
  const executable = input.executable.toLowerCase().replace(/\.(cmd|exe)$/u, "");
  switch (executable) {
    case "node":
      await validateNodeCommand(root, input.args, cwd);
      return { executable: process.execPath, args: input.args };
    case "python":
    case "python3":
      await validatePythonCommand(root, input.args, cwd);
      return { executable, args: input.args };
    case "pytest":
      return { executable: "pytest", args: input.args };
    case "pnpm":
    case "npm":
      validatePackageScriptCommand(executable, input.args);
      return await packageManagerCommand(executable, input.args);
    case "go":
      validateGoCommand(input.args);
      return { executable: "go", args: input.args };
    default:
      throw toolError("command_executable_denied", `${input.executable} is not in the run_command allowlist.`, false, "not_started");
  }
}

function assertNoExternalPathArguments(args: readonly string[]): void {
  for (const argument of args) {
    const candidates = [argument, argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : ""];
    if (candidates.some((candidate) => isAbsolute(candidate) || candidate.replaceAll("\\", "/").split("/").includes(".."))) {
      throw toolError("command_argument_denied", "Command arguments cannot reference paths outside the workspace.", false, "not_started");
    }
  }
}

async function validateNodeCommand(root: string, args: readonly string[], cwd: string): Promise<void> {
  const script = args[0];
  if (!script || script.startsWith("-") || script.includes("\0")) {
    throw toolError("command_argument_denied", "node requires a workspace script file; inline evaluation is denied.", false, "not_started");
  }
  const path = resolve(cwd, script);
  assertContained(root, path);
  await resolveWriteTarget(root, normalizeRelative(root, path), true);
}

async function validatePythonCommand(root: string, args: readonly string[], cwd: string): Promise<void> {
  if (args[0] === "-m") {
    if (args[1] !== "pytest" && args[1] !== "unittest") {
      throw toolError("command_argument_denied", "Only pytest and unittest Python modules are allowed.", false, "not_started");
    }
    return;
  }
  const script = args[0];
  if (!script || script.startsWith("-")) {
    throw toolError("command_argument_denied", "python requires a workspace script file; inline evaluation is denied.", false, "not_started");
  }
  const path = resolve(cwd, script);
  assertContained(root, path);
  await resolveWriteTarget(root, normalizeRelative(root, path), true);
}

function validatePackageScriptCommand(executable: string, args: readonly string[]): void {
  const command = args[0]?.toLowerCase();
  if (!command || !new Set(["build", "check", "lint", "run", "start", "test", "typecheck"]).has(command)) {
    throw toolError(
      "command_argument_denied",
      `${executable} is limited to existing package scripts; dependency installation requires separate approval.`,
      false,
      "not_started",
    );
  }
  if (command === "run" && (!args[1] || args[1]?.startsWith("-"))) {
    throw toolError("command_argument_denied", `${executable} run requires a script name.`, false, "not_started");
  }
}

function validateGoCommand(args: readonly string[]): void {
  if (!args[0] || !new Set(["build", "fmt", "test", "vet"]).has(args[0].toLowerCase())) {
    throw toolError("command_argument_denied", "go is limited to build, fmt, test, and vet.", false, "not_started");
  }
}

async function packageManagerCommand(executable: string, args: readonly string[]): Promise<ValidatedCommand> {
  if (process.platform !== "win32") return { executable, args };
  assertWindowsBatchArguments(args);
  const shim = await resolveWindowsBatchShim(executable);
  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot;
  if (!systemRoot) {
    throw toolError("command_unavailable", "The trusted Windows command processor path is unavailable.", false, "not_started");
  }
  const commandProcessor = await realpath(resolve(systemRoot, "System32", "cmd.exe")).catch(() => {
    throw toolError("command_unavailable", "The trusted Windows command processor is unavailable.", false, "not_started");
  });
  const commandLine = `call ${[shim, ...args].map(quoteWindowsBatchArgument).join(" ")}`;
  return {
    executable: commandProcessor,
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

function assertWindowsBatchArguments(args: readonly string[]): void {
  for (const argument of args) {
    if (/[&|<>^%!()"\r\n]/u.test(argument)) {
      throw toolError(
        "command_argument_denied",
        "Windows package-script arguments cannot contain command-processor metacharacters.",
        false,
        "not_started",
      );
    }
  }
}

async function resolveWindowsBatchShim(executable: string): Promise<string> {
  const searchPath = process.env.PATH ?? process.env.Path;
  if (!searchPath) throw toolError("command_unavailable", `${executable} is unavailable.`, false, "not_started");
  for (const entry of searchPath.split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, "");
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = resolve(directory, `${executable}.cmd`);
    const resolvedCandidate = await realpath(candidate).catch(() => null);
    if (!resolvedCandidate) continue;
    const metadata = await lstat(resolvedCandidate).catch(() => null);
    if (metadata?.isFile()) return resolvedCandidate;
  }
  throw toolError("command_unavailable", `${executable} is unavailable.`, false, "not_started");
}

function quoteWindowsBatchArgument(argument: string): string {
  return `"${argument}"`;
}

interface RunProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly context: ToolExecutionContext;
  readonly timeoutMs: number;
  readonly stdin: string | null;
  readonly sideEffectStatusAfterStart: StructuredError["sideEffectStatus"];
  readonly windowsVerbatimArguments?: boolean;
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

async function runProcess(input: RunProcessInput): Promise<ProcessResult> {
  assertActive(input.context, "not_started");
  return await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.environment,
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: input.windowsVerbatimArguments ?? false,
        shell: false,
        stdio: "pipe",
      });
    } catch (error: unknown) {
      rejectPromise(toolError("command_unavailable", error instanceof Error ? error.message : "The executable is unavailable.", false, "not_started"));
      return;
    }

    const stdout = new BoundedBytes(MAX_COMMAND_OUTPUT_BYTES);
    const stderr = new BoundedBytes(MAX_COMMAND_OUTPUT_BYTES);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const callerDeadline = input.context.deadlineAt
      ? Math.max(0, Date.parse(input.context.deadlineAt) - Date.now())
      : Number.POSITIVE_INFINITY;
    const timeoutMs = Math.min(input.timeoutMs, callerDeadline);
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      void terminateProcessTree(child);
    };
    input.context.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => finish(() => rejectPromise(toolError("command_unavailable", error.message, false, "not_started"))));
    child.on("close", (code) => finish(() => {
      if (timedOut) {
        rejectPromise(toolError("command_timeout", "The command exceeded its execution timeout.", false, input.sideEffectStatusAfterStart));
      } else if (cancelled || input.context.signal.aborted) {
        rejectPromise(toolError("cancelled", "The command was cancelled and its side effects require inspection.", false, input.sideEffectStatusAfterStart));
      } else if (code === null) {
        rejectPromise(toolError("command_exit_unknown", "The command ended without an exit code.", false, input.sideEffectStatusAfterStart));
      } else {
        resolvePromise({
          exitCode: code,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      }
    }));
    if (input.stdin === null) child.stdin.end();
    else child.stdin.end(input.stdin, "utf8");

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.context.signal.removeEventListener("abort", onAbort);
      callback();
    }
  });
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        env: baseEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      const forceParentAndFinish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        if (child.exitCode === null) child.kill("SIGKILL");
        resolvePromise();
      };
      const fallback = setTimeout(() => {
        killer.kill("SIGKILL");
        forceParentAndFinish();
      }, 5_000);
      killer.once("close", forceParentAndFinish);
      killer.once("error", forceParentAndFinish);
    });
    return;
  }
  const processGroup = -(child.pid);
  try {
    process.kill(processGroup, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forced = setTimeout(() => {
    try {
      process.kill(processGroup, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  child.once("close", () => clearTimeout(forced));
}

class BoundedBytes {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  add(chunk: Buffer): void {
    const remaining = this.limit - this.#bytes;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      this.#chunks.push(kept);
      this.#bytes += kept.byteLength;
    }
    if (chunk.byteLength > remaining) this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

function assertActive(
  context: ToolExecutionContext,
  sideEffectStatus: StructuredError["sideEffectStatus"],
): void {
  if (context.signal.aborted || (context.deadlineAt && Date.now() >= Date.parse(context.deadlineAt))) {
    throw toolError("cancelled", "The tool operation was cancelled.", false, sideEffectStatus);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function toolError(
  category: string,
  message: string,
  retryable = false,
  sideEffectStatus: StructuredError["sideEffectStatus"] = "not_started",
): ToolExecutionError {
  return new ToolExecutionError({ category, message, retryable, sideEffectStatus, recovery: null });
}

function unknownAfterWrite(error: unknown, category: string, message: string): ToolExecutionError {
  if (error instanceof ToolExecutionError) {
    return toolError(error.details.category, error.details.message, false, "unknown");
  }
  return toolError(category, message, false, "unknown");
}
