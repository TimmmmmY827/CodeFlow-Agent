import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import {
  evaluationLanguageSchema,
  evaluationSuiteManifestSchema,
  type EvaluationLanguage,
  type EvaluationSuiteManifest,
  type EvaluationTask,
} from "./evaluation.js";

const execFileAsync = promisify(execFile);
const VERIFIER_SCHEMA_VERSION = 1;
const verifierDefinitionSchema = z.object({
  schemaVersion: z.literal(VERIFIER_SCHEMA_VERSION),
  executable: z.enum(["node", "python", "go"]),
  args: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(120_000),
});

export interface FixtureResetResult {
  readonly taskId: string;
  readonly workspace: string;
  readonly snapshotHash: string;
  readonly gitHead: string;
}

export interface FixtureVerificationResult {
  readonly taskId: string;
  readonly status: "passed" | "failed" | "environment_failed" | "harness_failed";
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly errorCategory: string | null;
}

export interface FixtureSelfTestItem {
  readonly taskId: string;
  readonly baselineRejected: boolean;
  readonly goldPassed: boolean;
  readonly badRejected: boolean;
}

export interface FixtureSelfTestReport {
  readonly suiteVersion: string;
  readonly items: readonly FixtureSelfTestItem[];
  readonly passed: boolean;
}

export interface E1FixtureHarnessOptions {
  readonly repositoryRoot?: string;
}

export class E1FixtureHarness {
  readonly #repositoryRoot: string;
  readonly #suiteRoot: string;

  constructor(options: E1FixtureHarnessOptions = {}) {
    this.#repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
    this.#suiteRoot = path.join(this.#repositoryRoot, "eval", "e1");
  }

  async loadManifest(): Promise<EvaluationSuiteManifest> {
    const raw = JSON.parse(await readFile(path.join(this.#suiteRoot, "manifest.json"), "utf8")) as unknown;
    return evaluationSuiteManifestSchema.parse(raw);
  }

  async validate(): Promise<EvaluationSuiteManifest> {
    const manifest = await this.loadManifest();
    for (const task of manifest.tasks) {
      const fixtureHash = await hashDirectory(this.#fixtureSnapshot(task.id));
      if (fixtureHash !== task.fixture.snapshotHash) {
        throw new Error(`Fixture ${task.id} snapshot hash mismatch: expected ${task.fixture.snapshotHash}, received ${fixtureHash}.`);
      }
      const verifierHash = await hashDirectory(this.#verifierRoot(task.id));
      const expectedVerifier = task.hiddenVerifiers[0];
      if (expectedVerifier === undefined || verifierHash !== expectedVerifier.artifactHash) {
        throw new Error(`Fixture ${task.id} verifier hash mismatch.`);
      }
      verifierDefinitionSchema.parse(JSON.parse(await readFile(path.join(this.#verifierRoot(task.id), "verifier.json"), "utf8")));
      await access(this.#solutionPatch(task.id, "gold"));
      await access(this.#solutionPatch(task.id, "bad"));
    }
    return manifest;
  }

  async reset(taskId: string, destination: string): Promise<FixtureResetResult> {
    const manifest = await this.validate();
    const task = requireTask(manifest, taskId);
    const workspace = path.resolve(destination);
    await assertDestinationDoesNotExist(workspace);
    await copyDirectory(this.#fixtureSnapshot(task.id), workspace);
    await initializeFixtureGit(workspace);
    const { stdout } = await runCheckedProcess("git", ["rev-parse", "HEAD"], workspace, 10_000);
    return {
      taskId: task.id,
      workspace,
      snapshotHash: task.fixture.snapshotHash,
      gitHead: stdout.trim(),
    };
  }

  async verify(taskId: string, workspaceInput: string): Promise<FixtureVerificationResult> {
    const startedAt = performance.now();
    const manifest = await this.validate();
    const task = requireTask(manifest, taskId);
    const workspace = await realpath(path.resolve(workspaceInput));
    const scratchRoot = await mkdtemp(path.join(tmpdir(), `codeflow-e1-verify-${task.id}-`));
    const candidate = path.join(scratchRoot, "candidate");

    try {
      const boundaryViolation = await findModificationBoundaryViolation(
        this.#fixtureSnapshot(task.id),
        workspace,
        task.editablePaths,
      );
      if (boundaryViolation !== null) {
        return {
          taskId: task.id,
          status: "failed",
          durationMs: performance.now() - startedAt,
          exitCode: null,
          errorCategory: "modification_boundary_violated",
        };
      }
      await copyDirectory(workspace, candidate, new Set([".git", "_codeflow_hidden"]));
      await copyVerifierPayload(this.#verifierRoot(task.id), candidate);
      const verifier = verifierDefinitionSchema.parse(
        JSON.parse(await readFile(path.join(this.#verifierRoot(task.id), "verifier.json"), "utf8")),
      );
      const result = await runProcess(verifier.executable, verifier.args, candidate, verifier.timeoutMs);
      return {
        taskId: task.id,
        status: result.exitCode === 0 ? "passed" : "failed",
        durationMs: performance.now() - startedAt,
        exitCode: result.exitCode,
        errorCategory: result.exitCode === 0 ? null : "verifier_rejected",
      };
    } catch (error) {
      const failure = classifyVerifierError(error);
      return {
        taskId: task.id,
        status: failure.status,
        durationMs: performance.now() - startedAt,
        exitCode: failure.exitCode,
        errorCategory: failure.category,
      };
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  }

  async selfTest(languages: readonly EvaluationLanguage[] = evaluationLanguageSchema.options): Promise<FixtureSelfTestReport> {
    const manifest = await this.validate();
    const selected = new Set(evaluationLanguageSchema.array().min(1).parse(languages));
    const root = await mkdtemp(path.join(tmpdir(), "codeflow-e1-self-test-"));
    const items: FixtureSelfTestItem[] = [];

    try {
      for (const task of manifest.tasks.filter((candidate) => selected.has(candidate.language))) {
        const baseline = path.join(root, `${task.id}-baseline`);
        const gold = path.join(root, `${task.id}-gold`);
        const bad = path.join(root, `${task.id}-bad`);

        await this.reset(task.id, baseline);
        const baselineResult = await this.verify(task.id, baseline);
        assertVerifierEnvironment(task, baselineResult);

        await this.reset(task.id, gold);
        await applyPatch(gold, this.#solutionPatch(task.id, "gold"));
        const goldResult = await this.verify(task.id, gold);
        assertVerifierEnvironment(task, goldResult);

        await this.reset(task.id, bad);
        await applyPatch(bad, this.#solutionPatch(task.id, "bad"));
        const badResult = await this.verify(task.id, bad);
        assertVerifierEnvironment(task, badResult);

        items.push({
          taskId: task.id,
          baselineRejected: baselineResult.status === "failed",
          goldPassed: goldResult.status === "passed",
          badRejected: badResult.status === "failed",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    return {
      suiteVersion: manifest.version,
      items,
      passed: items.length > 0 && items.every((item) => item.baselineRejected && item.goldPassed && item.badRejected),
    };
  }

  #fixtureSnapshot(taskId: string): string {
    return path.join(this.#suiteRoot, "fixtures", taskId, "snapshot");
  }

  #verifierRoot(taskId: string): string {
    return path.join(this.#suiteRoot, "verifiers", taskId);
  }

  #solutionPatch(taskId: string, kind: "gold" | "bad"): string {
    return path.join(this.#suiteRoot, "solutions", taskId, `${kind}.patch`);
  }
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of await listFiles(root)) {
    const content = await readFile(path.join(root, relativePath));
    hash.update(relativePath.replaceAll(path.sep, "/"), "utf8");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function listFiles(root: string, current = "", ignored = new Set<string>()): Promise<string[]> {
  const directory = path.join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort(compareDirectoryEntries)) {
    if (ignored.has(entry.name)) continue;
    const relativePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Fixture trees cannot contain links: ${relativePath}.`);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath, ignored));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Fixture trees can contain only regular files and directories: ${relativePath}.`);
  }
  return files;
}

async function copyDirectory(source: string, destination: string, ignored = new Set<string>()): Promise<void> {
  await mkdir(destination, { recursive: false });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort(compareDirectoryEntries)) {
    if (ignored.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to copy linked fixture entry ${sourcePath}.`);
    if (entry.isDirectory()) await copyDirectory(sourcePath, destinationPath, ignored);
    else if (entry.isFile()) await cp(sourcePath, destinationPath, { force: false, errorOnExist: true });
    else throw new Error(`Refusing to copy non-regular fixture entry ${sourcePath}.`);
  }
}

async function copyVerifierPayload(verifierRoot: string, candidate: string): Promise<void> {
  const payloadRoot = path.join(verifierRoot, "payload");
  for (const relativePath of await listFiles(payloadRoot)) {
    const target = path.join(candidate, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(payloadRoot, relativePath), target, { force: false, errorOnExist: true });
  }
}

async function initializeFixtureGit(workspace: string): Promise<void> {
  await runCheckedProcess("git", ["init", "--quiet"], workspace, 10_000);
  await runCheckedProcess("git", ["config", "user.name", "CodeFlow Eval"], workspace, 10_000);
  await runCheckedProcess("git", ["config", "user.email", "eval@codeflow.invalid"], workspace, 10_000);
  await runCheckedProcess("git", ["add", "--all"], workspace, 10_000);
  await runCheckedProcess("git", ["commit", "--quiet", "-m", "Trusted E1 fixture snapshot"], workspace, 10_000, {
    GIT_AUTHOR_DATE: "2026-08-22T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-22T00:00:00Z",
  });
}

async function applyPatch(workspace: string, patchFile: string): Promise<void> {
  await runCheckedProcess("git", ["apply", "--whitespace=nowarn", patchFile], workspace, 10_000);
}

async function findModificationBoundaryViolation(
  trustedSnapshot: string,
  workspace: string,
  editablePaths: readonly string[],
): Promise<string | null> {
  const ignored = new Set([".git", "_codeflow_hidden"]);
  const snapshotFiles = new Set(await listFiles(trustedSnapshot, "", ignored));
  const workspaceFiles = new Set(await listFiles(workspace, "", ignored));
  const allowed = editablePaths.map((value) => value.replaceAll("\\", "/"));
  const allPaths = [...new Set([...snapshotFiles, ...workspaceFiles])].sort();

  for (const relativePath of allPaths) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (allowed.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`))) continue;
    if (!snapshotFiles.has(relativePath) || !workspaceFiles.has(relativePath)) return normalized;
    const [expected, actual] = await Promise.all([
      readFile(path.join(trustedSnapshot, relativePath)),
      readFile(path.join(workspace, relativePath)),
    ]);
    if (!expected.equals(actual)) return normalized;
  }
  return null;
}

async function runCheckedProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runProcess(executable, args, cwd, timeoutMs, additionalEnvironment);
  if (result.exitCode !== 0) throw new Error(`${executable} exited with code ${result.exitCode}.`);
  return result;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd,
      env: createChildEnvironment(additionalEnvironment),
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      return {
        stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
        stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
        exitCode: error.code,
      };
    }
    throw error;
  }
}

function createChildEnvironment(additional: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...additional };
  for (const key of [
    "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP", "HOME",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PYTHONDONTWRITEBYTECODE = "1";
  environment.GOTOOLCHAIN = "local";
  return environment;
}

function compareDirectoryEntries(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function requireTask(manifest: EvaluationSuiteManifest, taskId: string): EvaluationTask {
  const task = manifest.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new TypeError(`Unknown E1 task ${taskId}.`);
  return task;
}

async function assertDestinationDoesNotExist(destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new Error(`Fixture destination already exists: ${destination}.`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function classifyVerifierError(error: unknown): {
  readonly status: "environment_failed" | "harness_failed";
  readonly exitCode: number | null;
  readonly category: string;
} {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return { status: "environment_failed", exitCode: null, category: "runtime_unavailable" };
  }
  if (error instanceof Error && "killed" in error && error.killed === true) {
    return { status: "environment_failed", exitCode: null, category: "verifier_timeout" };
  }
  return { status: "harness_failed", exitCode: null, category: "verifier_harness_failed" };
}

function assertVerifierEnvironment(task: EvaluationTask, result: FixtureVerificationResult): void {
  if (result.status === "environment_failed" || result.status === "harness_failed") {
    throw new Error(`${task.id} could not be verified: ${result.errorCategory}.`);
  }
}

export { hashDirectory };
