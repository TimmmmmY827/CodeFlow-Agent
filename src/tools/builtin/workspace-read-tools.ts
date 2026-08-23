import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { systemClock, type StructuredError } from "../../shared/contracts.js";
import { canonicalJson } from "../../shared/json.js";
import type { AnyToolDefinition, NormalizedToolInput, ResourceClaim, ToolDefinition, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../tool.js";
import type { ToolRegistry } from "../tool-registry.js";

const relativePathSchema = z.string().trim().min(1).max(1_024).default(".").superRefine((value, refinement) => {
  if (isAbsolute(value) || value.includes("\0")) {
    refinement.addIssue({ code: "custom", message: "Path must be a relative workspace path." });
  }
});

const listFilesInputSchema = z.object({
  path: relativePathSchema.optional().default("."),
  maxDepth: z.number().int().min(0).max(12).optional().default(4),
  maxEntries: z.number().int().min(1).max(2_000).optional().default(500),
}).strict();

const searchTextInputSchema = z.object({
  query: z.string().min(1).max(1_024),
  path: relativePathSchema.optional().default("."),
  regex: z.boolean().optional().default(false),
  caseSensitive: z.boolean().optional().default(false),
  maxMatches: z.number().int().min(1).max(500).optional().default(100),
}).strict();

const readFileInputSchema = z.object({
  path: relativePathSchema,
  startLine: z.number().int().positive().optional().default(1),
  endLine: z.number().int().positive().optional(),
  maxBytes: z.number().int().min(1).max(256_000).optional().default(64_000),
}).strict().superRefine((value, refinement) => {
  if (value.endLine !== undefined && value.endLine < value.startLine) {
    refinement.addIssue({ code: "custom", path: ["endLine"], message: "endLine must not precede startLine." });
  }
});

const gitDiffInputSchema = z.object({
  scope: z.enum(["working", "staged", "base"]).optional().default("working"),
  base: z.string().trim().min(1).max(256).optional(),
  paths: z.array(relativePathSchema).max(50).optional().default([]),
  maxBytes: z.number().int().min(1).max(256_000).optional().default(64_000),
}).strict().superRefine((value, refinement) => {
  if (value.scope === "base" && !value.base) {
    refinement.addIssue({ code: "custom", path: ["base"], message: "base is required for a base diff." });
  }
  if (value.base?.startsWith("-") || (value.base && !/^[A-Za-z0-9._/~^{}-]+$/.test(value.base))) {
    refinement.addIssue({ code: "custom", path: ["base"], message: "base is not a safe Git revision." });
  }
});

const gitLogInputSchema = z.object({
  maxCount: z.number().int().min(1).max(100).optional().default(20),
  from: z.string().trim().min(1).max(256).optional(),
  path: relativePathSchema.optional(),
}).strict().superRefine((value, refinement) => {
  if (value.from?.startsWith("-") || (value.from && !/^[A-Za-z0-9._/~^{}-]+$/.test(value.from))) {
    refinement.addIssue({ code: "custom", path: ["from"], message: "from is not a safe Git revision." });
  }
});

const listFilesOutputSchema = z.object({
  entries: z.array(z.object({
    path: z.string(),
    type: z.enum(["file", "directory"]),
    size: z.number().int().nonnegative().nullable(),
  }).strict()),
  truncated: z.boolean(),
  skippedLinks: z.number().int().nonnegative(),
}).strict();

const searchTextOutputSchema = z.object({
  matches: z.array(z.object({
    path: z.string(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    text: z.string(),
  }).strict()),
  truncated: z.boolean(),
  backend: z.enum(["ripgrep", "node"]),
}).strict();

const readFileOutputSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  content: z.string(),
  truncated: z.boolean(),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  byteLength: z.number().int().nonnegative(),
}).strict();

const gitStatusOutputSchema = z.object({
  clean: z.boolean(),
  entries: z.array(z.object({
    status: z.string(),
    path: z.string(),
    originalPath: z.string().nullable().optional(),
  }).strict()),
  truncated: z.boolean(),
}).strict();

const gitDiffOutputSchema = z.object({
  scope: z.enum(["working", "staged", "base"]),
  base: z.string().nullable(),
  diff: z.string(),
  truncated: z.boolean(),
  contentSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const gitLogOutputSchema = z.object({
  commits: z.array(z.object({
    hash: z.string(),
    authoredAt: z.string(),
    author: z.string(),
    subject: z.string(),
  }).strict()),
  truncated: z.boolean(),
}).strict();

const IGNORED_DIRECTORIES = new Set([".git", ".codeflow", "node_modules", "dist", "artifacts"]);
const SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_MAX_FILES = 10_000;
const SEARCH_MAX_TOTAL_BYTES = 20_000_000;
const SEARCH_MAX_FILE_BYTES = 2_000_000;

export interface WorkspaceReadToolOptions {
  /** Test seam and deployment override. Missing commands use the bounded Node fallback. */
  readonly searchCommand?: string;
}

export function createWorkspaceReadTools(options: WorkspaceReadToolOptions = {}): readonly AnyToolDefinition[] {
  return [
    createListFilesTool(),
    createSearchTextTool(options),
    createReadFileTool(),
    createGitStatusTool(),
    createGitDiffTool(),
    createGitLogTool(),
  ];
}

export function registerWorkspaceReadTools(registry: ToolRegistry, options: WorkspaceReadToolOptions = {}): void {
  for (const tool of createWorkspaceReadTools(options)) registry.register(tool);
}

export function createListFilesTool(): ToolDefinition<z.infer<typeof listFilesInputSchema>, z.infer<typeof listFilesOutputSchema>> {
  return readOnlyTool("list_files", "List bounded files and directories inside the workspace.", listFilesInputSchema, listFilesOutputSchema, normalizePathInput, (input) => pathClaim(input.path), async (input, context) => {
    const boundary = await resolveWorkspacePath(context.workspace, input.path, true);
    const entries: { path: string; type: "file" | "directory"; size: number | null }[] = [];
    let truncated = false;
    let skippedLinks = 0;

    const walk = async (directory: string, depth: number): Promise<void> => {
      assertActive(context);
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const child of children) {
        if (entries.length >= input.maxEntries) {
          truncated = true;
          return;
        }
        if (isIgnoredDirectoryName(child.name)) continue;
        const absolute = resolve(directory, child.name);
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) {
          skippedLinks += 1;
          continue;
        }
        const itemPath = normalizeRelative(boundary.root, absolute);
        if (metadata.isDirectory()) {
          entries.push({ path: `${itemPath}/`, type: "directory", size: null });
          if (depth < input.maxDepth) await walk(absolute, depth + 1);
        } else if (metadata.isFile()) {
          entries.push({ path: itemPath, type: "file", size: metadata.size });
        }
      }
    };

    const metadata = await lstat(boundary.candidate);
    if (metadata.isDirectory()) await walk(boundary.candidate, 0);
    else if (metadata.isFile()) entries.push({ path: normalizeRelative(boundary.root, boundary.candidate), type: "file", size: metadata.size });
    else throw toolError("unsupported_file_type", "The requested path is not a regular file or directory.");
    return { entries, truncated, skippedLinks };
  });
}

export function createSearchTextTool(options: WorkspaceReadToolOptions = {}): ToolDefinition<z.infer<typeof searchTextInputSchema>, z.infer<typeof searchTextOutputSchema>> {
  return readOnlyTool("search_text", "Search bounded UTF-8 workspace text with ripgrep.", searchTextInputSchema, searchTextOutputSchema, normalizePathInput, (input) => pathClaim(input.path), async (input, context) => {
    const boundary = await resolveWorkspacePath(context.workspace, input.path, true);
    const args = ["--line-number", "--column", "--no-heading", "--color", "never", "--glob", "!.git/**", "--glob", "!.codeflow/**", "--glob", "!node_modules/**", "--glob", "!dist/**", "--glob", "!artifacts/**"];
    if (!input.regex) args.push("--fixed-strings");
    if (!input.caseSensitive) args.push("--ignore-case");
    args.push("--", input.query, normalizeRelative(boundary.root, boundary.candidate) || ".");
    try {
      const result = await runCommand(options.searchCommand ?? "rg", args, boundary.root, context, 512_000, [0, 1]);
      const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
      const matches = lines.slice(0, input.maxMatches).map(parseSearchMatch);
      return { matches, truncated: result.truncated || lines.length > matches.length, backend: "ripgrep" };
    } catch (error: unknown) {
      if (!(error instanceof ToolExecutionError) || error.details.category !== "command_unavailable") throw error;
      return await searchTextWithoutRipgrep(boundary, input, context);
    }
  });
}

export function createReadFileTool(): ToolDefinition<z.infer<typeof readFileInputSchema>, z.infer<typeof readFileOutputSchema>> {
  return readOnlyTool("read_file", "Read a bounded UTF-8 file with line metadata and SHA-256 evidence.", readFileInputSchema, readFileOutputSchema, normalizePathInput, (input) => pathClaim(input.path), async (input, context) => {
    const boundary = await resolveWorkspacePath(context.workspace, input.path, false);
    assertActive(context);
    const metadata = await lstat(boundary.candidate);
    if (!metadata.isFile()) throw toolError("not_a_file", "The requested path is not a regular file.");
    if (metadata.size > 2_000_000) throw toolError("file_too_large", "The file exceeds the 2 MB read safety limit.");
    const bytes = await readFile(boundary.candidate);
    assertActive(context);
    const afterRead = await realpath(resolve(boundary.root, input.path)).catch(() => {
      throw toolError("file_changed_during_read", "The file path changed while it was being read.", true);
    });
    if (afterRead !== boundary.candidate) {
      throw toolError("file_changed_during_read", "The file path changed while it was being read.", true);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw toolError("unsupported_encoding", "read_file accepts valid UTF-8 text only.");
    }
    const lines = text.split(/\r?\n/u);
    const requestedEnd = Math.min(input.endLine ?? lines.length, lines.length);
    const selected = lines.slice(input.startLine - 1, requestedEnd).join("\n");
    const selectedBytes = Buffer.from(selected, "utf8");
    const content = selectedBytes.byteLength <= input.maxBytes
      ? selected
      : selectedBytes.subarray(0, input.maxBytes).toString("utf8");
    return {
      path: normalizeRelative(boundary.root, boundary.candidate),
      startLine: input.startLine,
      endLine: requestedEnd,
      totalLines: lines.length,
      content,
      truncated: requestedEnd < lines.length || selectedBytes.byteLength > input.maxBytes,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.byteLength,
    };
  });
}

export function createGitStatusTool(): ToolDefinition<Record<string, never>, z.infer<typeof gitStatusOutputSchema>> {
  return readOnlyTool("git_status", "Return machine-readable Git working tree status.", z.object({}).strict(), gitStatusOutputSchema, identityNormalization, repositoryClaim, async (_input, context) => {
    const root = await assertGitWorkspace(context);
    const result = await runGitCommand(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "./"], root, context, 256_000, [0]);
    const records = parseGitStatus(result.stdout);
    return { clean: records.length === 0, entries: records, truncated: result.truncated };
  });
}

export function createGitDiffTool(): ToolDefinition<z.infer<typeof gitDiffInputSchema>, z.infer<typeof gitDiffOutputSchema>> {
  return readOnlyTool("git_diff", "Return a bounded working, staged, or base Git diff.", gitDiffInputSchema, gitDiffOutputSchema, normalizePathListInput, repositoryClaim, async (input, context) => {
    const root = await assertGitWorkspace(context);
    for (const path of input.paths) await resolveWorkspacePath(root, path, true, false);
    const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3"];
    if (input.scope === "staged") args.push("--cached");
    if (input.scope === "base" && input.base) args.push(input.base);
    args.push("--", ...(input.paths.length > 0 ? input.paths.map(toGitPathspec) : ["./"]));
    const result = await runGitCommand(args, root, context, input.maxBytes, [0]);
    return {
      scope: input.scope,
      base: input.base ?? null,
      diff: result.stdout,
      truncated: result.truncated,
      contentSha256: `sha256:${createHash("sha256").update(result.stdout).digest("hex")}`,
    };
  });
}

export function createGitLogTool(): ToolDefinition<z.infer<typeof gitLogInputSchema>, z.infer<typeof gitLogOutputSchema>> {
  return readOnlyTool("git_log", "Return bounded Git history with fixed fields.", gitLogInputSchema, gitLogOutputSchema, normalizeOptionalPathInput, repositoryClaim, async (input, context) => {
    const root = await assertGitWorkspace(context);
    if (input.path) await resolveWorkspacePath(root, input.path, true, false);
    const args = ["log", `--max-count=${input.maxCount}`, "--format=%H%x1f%aI%x1f%an%x1f%s%x1e"];
    if (input.from) args.push(input.from);
    if (input.path) args.push("--", toGitPathspec(input.path));
    else args.push("--", "./");
    const result = await runGitCommand(args, root, context, 512_000, [0]);
    const commits = result.stdout.split("\u001e").map((value) => value.trim()).filter(Boolean).map((record) => {
      const [hash = "", authoredAt = "", author = "", subject = ""] = record.split("\u001f");
      return { hash, authoredAt, author, subject };
    });
    return { commits, truncated: result.truncated };
  });
}

function readOnlyTool<TInput, TOutput>(
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
    normalizationVersion: "normalization:workspace-read-v1",
    description,
    risk: "automatic",
    sideEffect: "none",
    retryPolicy: "safe",
    inputSchema,
    outputSchema,
    availability: { available: true, reasonCode: null, message: null, checkedAt: systemClock.utcNow() },
    normalizeInput,
    claimResources,
    execute,
  };
}

function identityNormalization<TInput>(input: TInput): NormalizedToolInput<TInput> {
  return { effectiveInput: input, transformations: [] };
}

function normalizePathInput<TInput extends { readonly path: string }>(input: TInput): NormalizedToolInput<TInput> {
  const path = canonicalRelativePath(input.path);
  return {
    effectiveInput: { ...input, path },
    transformations: path === input.path ? [] : [pathTransformation("/path", input.path, path)],
  };
}

function normalizeOptionalPathInput<TInput extends { readonly path?: string | undefined }>(input: TInput): NormalizedToolInput<TInput> {
  if (input.path === undefined) return identityNormalization(input);
  const path = canonicalRelativePath(input.path);
  return {
    effectiveInput: { ...input, path },
    transformations: path === input.path ? [] : [pathTransformation("/path", input.path, path)],
  };
}

function normalizePathListInput<TInput extends { readonly paths: readonly string[] }>(input: TInput): NormalizedToolInput<TInput> {
  const paths = input.paths.map(canonicalRelativePath);
  const changed = paths.some((path, index) => path !== input.paths[index]);
  return {
    effectiveInput: { ...input, paths },
    transformations: changed ? [pathTransformation("/paths", input.paths, paths)] : [],
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
    ruleCode: "normalize_relative_path_v1",
    beforeHash: digestCanonical(before),
    afterHash: digestCanonical(after),
  } as const;
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function pathClaim(path: string): readonly ResourceClaim[] {
  return [{ key: `path:${path.replaceAll("\\", "/")}`, mode: "read", scope: "path" }];
}

function repositoryClaim(): readonly ResourceClaim[] {
  return [{ key: "repository:workspace", mode: "read", scope: "repository" }];
}

async function resolveWorkspacePath(
  workspace: string,
  requested: string,
  allowDirectory: boolean,
  mustExist = true,
): Promise<{ root: string; candidate: string }> {
  const root = await realpath(workspace).catch(() => { throw toolError("workspace_unavailable", "The workspace root is unavailable.", true); });
  const unresolved = resolve(root, requested);
  assertContained(root, unresolved);
  assertReadableWorkspacePath(root, unresolved);
  if (!mustExist) return { root, candidate: unresolved };
  const candidate = await realpath(unresolved).catch(() => { throw toolError("path_not_found", "The requested workspace path does not exist."); });
  assertContained(root, candidate);
  const metadata = await lstat(unresolved);
  if (metadata.isSymbolicLink()) throw toolError("workspace_link_rejected", "Symbolic links and junctions are not followed.");
  if (!allowDirectory && metadata.isDirectory()) throw toolError("not_a_file", "The requested path is a directory.");
  return { root, candidate };
}

function assertReadableWorkspacePath(root: string, candidate: string): void {
  const segments = relative(root, candidate).split(sep).filter(Boolean);
  if (segments.some(isIgnoredDirectoryName)) {
    throw toolError("path_ignored", "The requested path is excluded from model-visible workspace reads.");
  }
}

function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORIES.has(process.platform === "win32" ? name.toLowerCase() : name);
}

function assertContained(root: string, candidate: string): void {
  const value = relative(root, candidate);
  if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))) return;
  throw toolError("workspace_boundary_violation", "The requested path escapes the workspace boundary.");
}

async function assertGitWorkspace(context: ToolExecutionContext): Promise<string> {
  const root = await realpath(context.workspace).catch(() => { throw toolError("workspace_unavailable", "The workspace root is unavailable.", true); });
  const result = await runGitCommand(["rev-parse", "--show-toplevel"], root, context, 8_192, [0], "not_a_git_repository");
  const gitRoot = await realpath(result.stdout.trim()).catch(() => { throw toolError("git_repository_unavailable", "The Git repository root is unavailable.", true); });
  assertContained(gitRoot, root);
  return root;
}

function normalizeRelative(root: string, candidate: string): string {
  const value = relative(root, candidate).split(sep).join("/");
  return value || ".";
}

function parseSearchMatch(line: string): z.infer<typeof searchTextOutputSchema>["matches"][number] {
  const match = /^(.+?):(\d+):(\d+):(.*)$/u.exec(line);
  if (!match) return { path: "", line: 0, column: 0, text: line };
  return { path: (match[1] ?? "").replaceAll("\\", "/"), line: Number(match[2]), column: Number(match[3]), text: match[4] ?? "" };
}

function parseGitStatus(output: string): z.infer<typeof gitStatusOutputSchema>["entries"] {
  const tokens = output.split("\0");
  const records: z.infer<typeof gitStatusOutputSchema>["entries"] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3).replaceAll("\\", "/");
    if (status.includes("R") || status.includes("C")) {
      const originalPath = tokens[index + 1];
      records.push({ status, path, originalPath: originalPath?.replaceAll("\\", "/") ?? null });
      index += 1;
    } else {
      records.push({ status, path });
    }
  }
  return records;
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  context: ToolExecutionContext,
  maxBytes: number,
  acceptedExitCodes: readonly number[],
  failureCategory = "command_failed",
  environment?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; truncated: boolean }> {
  assertActive(context);
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: environment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const callerDeadlineMs = context.deadlineAt ? Math.max(0, Date.parse(context.deadlineAt) - Date.now()) : Number.POSITIVE_INFINITY;
    const timeoutMs = Math.min(callerDeadlineMs, 10_000);
    let internalTimeout = false;
    const timeout = setTimeout(() => {
      internalTimeout = true;
      child.kill();
    }, timeoutMs);
    const onAbort = (): void => { child.kill(); };
    context.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.byteLength;
      }
      if (chunk.byteLength > remaining) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.reduce((total, item) => total + item.byteLength, 0) < 16_384) errors.push(chunk);
    });
    child.on("error", (error) => finish(() => rejectPromise(toolError("command_unavailable", `${command} is unavailable: ${error.message}`, false))));
    child.on("close", (code) => finish(() => {
      if (context.signal.aborted || (context.deadlineAt && Date.now() >= Date.parse(context.deadlineAt))) {
        rejectPromise(toolError("cancelled", "The tool operation was cancelled."));
      } else if (internalTimeout) {
        rejectPromise(toolError("command_timeout", `${command} exceeded the 10 second execution limit.`, true));
      } else if (code === null || !acceptedExitCodes.includes(code)) {
        const message = Buffer.concat(errors).toString("utf8").trim();
        rejectPromise(toolError(failureCategory, message || `${command} exited with code ${String(code)}.`));
      } else {
        resolvePromise({ stdout: Buffer.concat(chunks).toString("utf8"), truncated });
      }
    }));

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onAbort);
      callback();
    }
  });
}

async function runGitCommand(
  args: readonly string[],
  cwd: string,
  context: ToolExecutionContext,
  maxBytes: number,
  acceptedExitCodes: readonly number[],
  failureCategory = "command_failed",
): Promise<{ stdout: string; truncated: boolean }> {
  return await runCommand(
    "git",
    ["--no-optional-locks", ...args],
    cwd,
    context,
    maxBytes,
    acceptedExitCodes,
    failureCategory,
    gitEnvironment(),
  );
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
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
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) environment[key] = value;
  }
  environment.GIT_LITERAL_PATHSPECS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function toGitPathspec(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized === "." ? "./" : `./${normalized.replace(/^\.\//u, "")}`;
}

async function searchTextWithoutRipgrep(
  boundary: { root: string; candidate: string },
  input: z.infer<typeof searchTextInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof searchTextOutputSchema>> {
  const startedAt = Date.now();
  const matches: z.infer<typeof searchTextOutputSchema>["matches"] = [];
  let fileCount = 0;
  let totalBytes = 0;
  let truncated = false;
  const pattern = createSearchPattern(input.query, input.regex, input.caseSensitive);

  const inspectFile = async (absolute: string): Promise<void> => {
    assertSearchActive(context, startedAt);
    if (matches.length >= input.maxMatches || fileCount >= SEARCH_MAX_FILES || totalBytes >= SEARCH_MAX_TOTAL_BYTES) {
      truncated = true;
      return;
    }
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.size > SEARCH_MAX_FILE_BYTES) return;
    fileCount += 1;
    totalBytes += metadata.size;
    if (totalBytes > SEARCH_MAX_TOTAL_BYTES) {
      truncated = true;
      return;
    }
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) return;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      assertSearchActive(context, startedAt);
      const line = lines[lineIndex] ?? "";
      pattern.lastIndex = 0;
      for (;;) {
        const match = pattern.exec(line);
        if (!match) break;
        matches.push({
          path: normalizeRelative(boundary.root, absolute),
          line: lineIndex + 1,
          column: match.index + 1,
          text: line,
        });
        if (matches.length >= input.maxMatches) {
          truncated = true;
          return;
        }
        if (match[0] === "") pattern.lastIndex += 1;
      }
    }
  };

  const walk = async (absolute: string): Promise<void> => {
    assertSearchActive(context, startedAt);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isFile()) {
      await inspectFile(absolute);
      return;
    }
    if (!metadata.isDirectory()) return;
    const children = await readdir(absolute, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      if (truncated || isIgnoredDirectoryName(child.name) || child.isSymbolicLink()) continue;
      await walk(resolve(absolute, child.name));
    }
  };

  await walk(boundary.candidate);
  return { matches, truncated, backend: "node" };
}

function createSearchPattern(query: string, regex: boolean, caseSensitive: boolean): RegExp {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  try {
    return new RegExp(source, caseSensitive ? "gu" : "giu");
  } catch (error: unknown) {
    throw toolError(
      "invalid_search_pattern",
      error instanceof Error ? error.message : "The search pattern is invalid.",
    );
  }
}

function assertSearchActive(context: ToolExecutionContext, startedAt: number): void {
  assertActive(context);
  if (Date.now() - startedAt >= SEARCH_TIMEOUT_MS) {
    throw toolError("command_timeout", "The fallback search exceeded the 10 second execution limit.", true);
  }
}

function assertActive(context: ToolExecutionContext): void {
  if (context.signal.aborted || (context.deadlineAt && Date.now() >= Date.parse(context.deadlineAt))) {
    throw toolError("cancelled", "The tool operation was cancelled.");
  }
}

function toolError(
  category: string,
  message: string,
  retryable = false,
  sideEffectStatus: StructuredError["sideEffectStatus"] = "none",
): ToolExecutionError {
  return new ToolExecutionError({ category, message, retryable, sideEffectStatus, recovery: null });
}
