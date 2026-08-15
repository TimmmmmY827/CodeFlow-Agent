import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import type { StructuredError } from "../../shared/contracts.js";
import type { JsonObject } from "../../shared/json.js";
import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext } from "../tool.js";
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

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "artifacts"]);
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

export function createListFilesTool(): ToolDefinition<z.infer<typeof listFilesInputSchema>, JsonObject> {
  return readOnlyTool("list_files", "List bounded files and directories inside the workspace.", listFilesInputSchema, async (input, context) => {
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
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
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

export function createSearchTextTool(options: WorkspaceReadToolOptions = {}): ToolDefinition<z.infer<typeof searchTextInputSchema>, JsonObject> {
  return readOnlyTool("search_text", "Search bounded UTF-8 workspace text with ripgrep.", searchTextInputSchema, async (input, context) => {
    const boundary = await resolveWorkspacePath(context.workspace, input.path, true);
    const args = ["--line-number", "--column", "--no-heading", "--color", "never", "--glob", "!.git/**", "--glob", "!node_modules/**", "--glob", "!dist/**", "--glob", "!artifacts/**"];
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

export function createReadFileTool(): ToolDefinition<z.infer<typeof readFileInputSchema>, JsonObject> {
  return readOnlyTool("read_file", "Read a bounded UTF-8 file with line metadata and SHA-256 evidence.", readFileInputSchema, async (input, context) => {
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

export function createGitStatusTool(): ToolDefinition<Record<string, never>, JsonObject> {
  return readOnlyTool("git_status", "Return machine-readable Git working tree status.", z.object({}).strict(), async (_input, context) => {
    const root = await assertGitWorkspace(context);
    const result = await runGitCommand(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "./"], root, context, 256_000, [0]);
    const records = parseGitStatus(result.stdout);
    return { clean: records.length === 0, entries: records, truncated: result.truncated };
  });
}

export function createGitDiffTool(): ToolDefinition<z.infer<typeof gitDiffInputSchema>, JsonObject> {
  return readOnlyTool("git_diff", "Return a bounded working, staged, or base Git diff.", gitDiffInputSchema, async (input, context) => {
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

export function createGitLogTool(): ToolDefinition<z.infer<typeof gitLogInputSchema>, JsonObject> {
  return readOnlyTool("git_log", "Return bounded Git history with fixed fields.", gitLogInputSchema, async (input, context) => {
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

function readOnlyTool<TInput>(
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  execute: (input: TInput, context: ToolExecutionContext) => Promise<JsonObject>,
): ToolDefinition<TInput, JsonObject> {
  return { name, description, risk: "automatic", sideEffect: "none", retryPolicy: "safe", inputSchema, execute };
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
  if (!mustExist) return { root, candidate: unresolved };
  const candidate = await realpath(unresolved).catch(() => { throw toolError("path_not_found", "The requested workspace path does not exist."); });
  assertContained(root, candidate);
  const metadata = await lstat(unresolved);
  if (metadata.isSymbolicLink()) throw toolError("workspace_link_rejected", "Symbolic links and junctions are not followed.");
  if (!allowDirectory && metadata.isDirectory()) throw toolError("not_a_file", "The requested path is a directory.");
  return { root, candidate };
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

function parseSearchMatch(line: string): JsonObject {
  const match = /^(.+?):(\d+):(\d+):(.*)$/u.exec(line);
  if (!match) return { path: "", line: 0, column: 0, text: line };
  return { path: (match[1] ?? "").replaceAll("\\", "/"), line: Number(match[2]), column: Number(match[3]), text: match[4] ?? "" };
}

function parseGitStatus(output: string): readonly JsonObject[] {
  const tokens = output.split("\0");
  const records: JsonObject[] = [];
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
): Promise<JsonObject> {
  const startedAt = Date.now();
  const matches: JsonObject[] = [];
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
      if (truncated || IGNORED_DIRECTORIES.has(child.name) || child.isSymbolicLink()) continue;
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
