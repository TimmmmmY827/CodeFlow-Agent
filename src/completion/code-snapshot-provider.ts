import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { createCodeSnapshot, type CodeSnapshot } from "../shared/contracts.js";
import type { CodeSnapshotProvider } from "./completion-context.js";

const PRIVATE_DIRECTORIES = new Set([".git", ".codeflow"]);

export class WorkspaceCodeSnapshotProvider implements CodeSnapshotProvider {
  async capture(workspacePath: string, configVersion: string): Promise<CodeSnapshot> {
    const workspace = await realpath(path.resolve(workspacePath));
    if (!(await stat(workspace)).isDirectory()) throw new TypeError("Completion workspace must be a directory.");

    const repositoryRoot = await detectRepositoryRoot(workspace);
    if (repositoryRoot !== null) {
      return await captureGitSnapshot(workspace, repositoryRoot.trim(), configVersion);
    }
    return await capturePlainWorkspaceSnapshot(workspace, configVersion);
  }
}

async function captureGitSnapshot(
  workspace: string,
  repositoryRootInput: string,
  configVersion: string,
): Promise<CodeSnapshot> {
  const repositoryRoot = await realpath(repositoryRootInput);
  const relativeWorkspace = path.relative(repositoryRoot, workspace);
  if (relativeWorkspace === ".." || relativeWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWorkspace)) {
    throw new Error("Git reported a repository root outside the completion workspace boundary.");
  }
  const head = await readHead(workspace);
  const pathspec = relativeWorkspace === "" ? "." : relativeWorkspace.replaceAll(path.sep, "/");
  const privatePrefix = pathspec === "." ? ".codeflow" : `${pathspec}/.codeflow`;
  const exclusions = [`:(exclude)${privatePrefix}`, `:(exclude)${privatePrefix}/**`];
  const [status, diff, untracked] = await Promise.all([
    runGit(repositoryRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", pathspec, ...exclusions]),
    captureGitDiff(repositoryRoot, head, pathspec, exclusions),
    runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec, ...exclusions]),
  ]);
  const untrackedDigest = await hashUntrackedFiles(repositoryRoot, splitNull(untracked));
  return createCodeSnapshot({
    workspacePath: workspace,
    codeVersion: head === null
      ? `git:unborn-${createHash("sha256").update(normalizeIdentity(repositoryRoot)).digest("hex")}`
      : `git:${head}`,
    diffHash: digest(Buffer.concat([
      Buffer.from(status, "utf8"),
      Buffer.from([0]),
      Buffer.from(diff, "utf8"),
      Buffer.from([0]),
      Buffer.from(untrackedDigest, "utf8"),
    ])),
    configVersion,
  });
}

async function captureGitDiff(
  repositoryRoot: string,
  head: string | null,
  pathspec: string,
  exclusions: readonly string[],
): Promise<string> {
  if (head !== null) {
    return await runGit(repositoryRoot, ["diff", "--no-ext-diff", "--binary", head, "--", pathspec, ...exclusions]);
  }
  const [staged, unstaged] = await Promise.all([
    runGit(repositoryRoot, ["diff", "--no-ext-diff", "--binary", "--cached", "--", pathspec, ...exclusions]),
    runGit(repositoryRoot, ["diff", "--no-ext-diff", "--binary", "--", pathspec, ...exclusions]),
  ]);
  return `${staged}\0${unstaged}`;
}

async function capturePlainWorkspaceSnapshot(workspace: string, configVersion: string): Promise<CodeSnapshot> {
  const entries = await collectEntries(workspace, "");
  const contentHash = createHash("sha256");
  for (const entry of entries) {
    contentHash.update(entry.relativePath);
    contentHash.update("\0");
    contentHash.update(entry.kind);
    contentHash.update("\0");
    contentHash.update(entry.content);
    contentHash.update("\0");
  }
  return createCodeSnapshot({
    workspacePath: workspace,
    codeVersion: `workspace:${createHash("sha256").update(normalizeIdentity(workspace)).digest("hex")}`,
    diffHash: `sha256:${contentHash.digest("hex")}`,
    configVersion,
  });
}

interface SnapshotEntry {
  readonly relativePath: string;
  readonly kind: "file" | "symlink";
  readonly content: Buffer;
}

async function collectEntries(root: string, relativeDirectory: string): Promise<SnapshotEntry[]> {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const children = await readdir(absoluteDirectory, { withFileTypes: true });
  const entries: SnapshotEntry[] = [];
  for (const child of children.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    if (PRIVATE_DIRECTORIES.has(caseFold(child.name))) continue;
    const relativePath = path.join(relativeDirectory, child.name);
    const absolutePath = path.join(root, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      entries.push({
        relativePath: relativePath.replaceAll(path.sep, "/"),
        kind: "symlink",
        content: Buffer.from(await readlink(absolutePath), "utf8"),
      });
    } else if (metadata.isDirectory()) {
      entries.push(...await collectEntries(root, relativePath));
    } else if (metadata.isFile()) {
      entries.push({
        relativePath: relativePath.replaceAll(path.sep, "/"),
        kind: "file",
        content: await readFile(absolutePath),
      });
    }
  }
  return entries;
}

async function hashUntrackedFiles(repositoryRoot: string, relativePaths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of [...relativePaths].sort()) {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relativeCheck = path.relative(repositoryRoot, absolutePath);
    if (relativeCheck === ".." || relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck)) {
      throw new Error("Git returned an untracked path outside the repository.");
    }
    const metadata = await lstat(absolutePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(metadata.isSymbolicLink() ? await readlink(absolutePath) : await readFile(absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0);
}

function caseFold(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function normalizeIdentity(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function detectRepositoryRoot(workspace: string): Promise<string | null> {
  try {
    return await runGit(workspace, ["rev-parse", "--show-toplevel"]);
  } catch (error: unknown) {
    if (error instanceof GitCommandError && error.stderr.includes("not a git repository")) return null;
    throw error;
  }
}

async function readHead(workspace: string): Promise<string | null> {
  try {
    return (await runGit(workspace, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch (error: unknown) {
    if (error instanceof GitCommandError && error.stderr.includes("Needed a single revision")) return null;
    throw error;
  }
}

class GitCommandError extends Error {
  constructor(readonly stderr: string, cause: Error) {
    super(stderr.trim() || cause.message, { cause });
    this.name = "GitCommandError";
  }
}

async function runGit(workspace: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile("git", ["--no-optional-locks", ...args], {
      cwd: workspace,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: gitEnvironment(),
    }, (error, stdout, stderr) => error
      ? rejectPromise(new GitCommandError(stderr, error))
      : resolvePromise(stdout));
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["APPDATA", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) environment[key] = value;
  }
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LANG = "C";
  environment.LC_ALL = "C";
  return environment;
}
