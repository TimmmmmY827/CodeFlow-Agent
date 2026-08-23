import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { AgentEventLoop, type RunReadonlySessionResult } from "../agent/agent-event-loop.js";
import { CompletionGate, type CompletionSnapshot } from "../completion/completion-gate.js";
import { createAgentEvent, createEventContext } from "../events/agent-event.js";
import { reduceAgentEvents } from "../events/state-reducer.js";
import { DeepSeekChatAdapter } from "../model/deepseek-chat-adapter.js";
import { DEEPSEEK_PRICING_VERSION } from "../model/deepseek-pricing.js";
import type { ModelAdapter } from "../model/model-adapter.js";
import { type BudgetPolicy } from "../policy/budget-contracts.js";
import { PermissionEngine } from "../policy/permission-engine.js";
import { canonicalJson } from "../shared/json.js";
import {
  createStableId,
  stableIdSchema,
  systemClock,
  type Clock,
  type StableId,
  type StructuredError,
  type UtcTimestamp,
} from "../shared/contracts.js";
import { STORAGE_RECORD_SCHEMA_VERSION, type CreateSessionBundle, type WorkspaceRecord } from "../storage/contracts.js";
import { SqliteBudgetLedger } from "../storage/sqlite/sqlite-budget-ledger.js";
import { SqliteStorageDatabase } from "../storage/sqlite/sqlite-database.js";
import { SqliteEventStore } from "../storage/sqlite/sqlite-event-store.js";
import { SqliteExecutionJournal } from "../storage/sqlite/sqlite-execution-journal.js";
import { SqliteSessionRepository } from "../storage/sqlite/sqlite-session-repository.js";
import { SqliteWorkspaceRepository } from "../storage/sqlite/sqlite-workspace-repository.js";
import { registerWorkspaceReadTools } from "../tools/builtin/workspace-read-tools.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ToolRuntime } from "../tools/tool-runtime.js";
import type { SessionEventSource, SessionEventStreamOptions } from "../cli/ui/session-task-tree.js";
import { ReplayTailSessionEventSource } from "./session-event-source.js";

export const READONLY_MVP_BUDGET_POLICY: BudgetPolicy = Object.freeze({
  limits: {
    maxSteps: 4,
    maxToolCalls: 8,
    maxDurationMs: 2 * 60 * 1_000,
    maxInputTokens: 50_000,
    maxOutputTokens: 2_000,
    maxCostUsd: 0.1,
    maxRetriesPerOperation: 1,
    maxNoProgressCycles: 2,
  },
  softLimitRatio: 0.8,
  countWaitingTime: false,
});

export interface StartReadonlySessionRequest {
  readonly goal: string;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly deadlineAt?: UtcTimestamp | null;
}

export interface ReadonlySessionRunnerDependencies {
  readonly dataDirectory: string;
  readonly modelAdapter: ModelAdapter;
  readonly budgetPolicy?: BudgetPolicy;
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
  readonly clock?: Clock;
}

export interface ProductionReadonlySessionOptions {
  readonly dataDirectory: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface RunningReadonlySession extends SessionEventSource {
  readonly sessionId: StableId;
  readonly completion: Promise<RunReadonlySessionResult>;
  close(): void;
}

export async function startProductionReadonlySession(
  request: StartReadonlySessionRequest,
  options: ProductionReadonlySessionOptions,
): Promise<RunningReadonlySession> {
  return await startReadonlySession(request, {
    dataDirectory: options.dataDirectory,
    modelAdapter: new DeepSeekChatAdapter({
      apiKey: options.apiKey,
      model: options.model ?? "deepseek-v4-flash",
      timeoutMs: options.timeoutMs ?? 90_000,
    }),
  });
}

export async function startReadonlySession(
  request: StartReadonlySessionRequest,
  dependencies: ReadonlySessionRunnerDependencies,
): Promise<RunningReadonlySession> {
  const goal = request.goal.trim();
  if (!goal) throw new TypeError("goal must not be empty.");
  const workspace = await requireWorkspace(request.workspace);
  const dataDirectory = await canonicalizePotentialPath(dependencies.dataDirectory);
  assertPrivateDataDirectory(workspace, dataDirectory);
  const clock = dependencies.clock ?? systemClock;
  const registry = new ToolRegistry();
  registerWorkspaceReadTools(registry);
  const budgetPolicy = dependencies.budgetPolicy ?? READONLY_MVP_BUDGET_POLICY;
  const toolCatalogHash = registry.createManifest(clock.utcNow()).catalogHash;
  const configVersion = `config:${digest(canonicalJson({
    model: dependencies.modelAdapter.model,
    budgetPolicy,
    toolCatalogHash,
    mode: "readonly_analysis",
  })).slice("sha256:".length)}`;
  const storage = new SqliteStorageDatabase(path.join(dataDirectory, "codeflow.sqlite"), { clock });

  try {
    const createdAt = clock.utcNow();
    const workspaces = new SqliteWorkspaceRepository(storage);
    const workspaceRecord = await workspaces.getByNormalizedPath(workspace) ?? createWorkspaceRecord(workspace, createdAt);
    const bundle = createSessionBundle({
      workspace: workspaceRecord,
      goal,
      configVersion,
      toolCatalogHash,
      createdAt,
    });
    const sessions = new SqliteSessionRepository(storage, {
      deletedSessionIdentity: { hasDeletedSessionIdentity: () => false },
    });
    await sessions.create(bundle);
    const events = new SqliteEventStore(storage);
    const ledger = new SqliteBudgetLedger(storage);
    await ledger.initialize({
      sessionId: bundle.session.sessionId,
      policy: budgetPolicy,
      pricingVersion: DEEPSEEK_PRICING_VERSION,
    });
    const journal = new SqliteExecutionJournal(storage, events, ledger);
    const runtime = new ToolRuntime(registry, new PermissionEngine(clock), { journal });
    // Capture after private storage exists so an untracked .codeflow directory
    // has the same Git representation at admission and completion.
    const initialSnapshot = await captureWorkspaceSnapshot(workspace);
    const loop = new AgentEventLoop(events, {
      modelAdapter: dependencies.modelAdapter,
      toolRegistry: registry,
      toolRuntime: runtime,
      journal,
      completionGate: new CompletionGate(),
      completionSnapshotProvider: { capture: async () => await captureWorkspaceSnapshot(workspace) },
      maxSteps: dependencies.maxSteps ?? 4,
      maxOutputTokens: dependencies.maxOutputTokens ?? 512,
    });
    const identity = {
      sessionId: bundle.session.sessionId,
      taskId: bundle.rootTask.taskId,
      traceId: bundle.createdEvent.traceId,
      workspaceId: bundle.session.workspace.workspaceId,
      authorizationVersion: "authorization:readonly-v1",
      workspacePath: workspace,
      codeVersion: initialSnapshot.codeVersion,
      diffHash: initialSnapshot.diffHash,
      configVersion,
    } as const;
    const completion = Promise.resolve()
      .then(async () => await loop.runReadonlySession({
        ...identity,
        goal,
        signal: request.signal,
        deadlineAt: request.deadlineAt ?? null,
      }))
      .catch(async (error: unknown) => await recordUnexpectedFailure(journal, events, identity, error));
    const source = new ReplayTailSessionEventSource(bundle.session.sessionId, events);
    let closed = false;
    return {
      sessionId: bundle.session.sessionId,
      completion,
      streamEvents: (options: SessionEventStreamOptions) => source.streamEvents(options),
      close: () => {
        if (closed) return;
        closed = true;
        storage.close();
      },
    };
  } catch (error: unknown) {
    storage.close();
    throw error;
  }
}

interface SessionBundleInput {
  readonly workspace: WorkspaceRecord;
  readonly goal: string;
  readonly configVersion: string;
  readonly toolCatalogHash: string;
  readonly createdAt: UtcTimestamp;
}

function createSessionBundle(input: SessionBundleInput): CreateSessionBundle {
  const sessionId = createStableId();
  const taskId = createStableId();
  const traceId = createStableId();
  const createdEvent = createAgentEvent({
    sessionId,
    taskId,
    traceId,
    sequence: 0,
    type: "session.created",
    occurredAt: input.createdAt,
    context: createEventContext({
      workspacePath: input.workspace.root.normalizedPath,
      configVersion: input.configVersion,
    }),
    payload: { goal: input.goal },
  });
  return {
    session: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      sessionId,
      workspace: input.workspace,
      goal: input.goal,
      createdAt: input.createdAt,
      expiresAt: null,
      configVersion: input.configVersion,
      toolCatalogHash: input.toolCatalogHash,
    },
    rootTask: {
      schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
      taskId,
      actorId: createdEvent.actorId,
      title: input.goal,
      createdAt: input.createdAt,
    },
    createdEvent,
  };
}

function createWorkspaceRecord(workspace: string, createdAt: UtcTimestamp): WorkspaceRecord {
  return {
    schemaVersion: STORAGE_RECORD_SCHEMA_VERSION,
    workspaceId: deterministicWorkspaceId(workspace),
    root: { normalizedPath: workspace, displayPath: workspace },
    fingerprint: digest(`workspace:${normalizeWorkspaceIdentity(workspace)}`),
    createdAt,
  };
}

async function requireWorkspace(value: string): Promise<string> {
  const resolved = await realpath(path.resolve(value)).catch(() => {
    throw new TypeError("workspace must reference an existing directory.");
  });
  if (!(await stat(resolved)).isDirectory()) throw new TypeError("workspace must be a directory.");
  return path.normalize(resolved);
}

async function canonicalizePotentialPath(value: string): Promise<string> {
  let candidate = path.resolve(value);
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const canonicalAncestor = await realpath(candidate);
      return path.resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new TypeError("data directory must have an accessible parent directory.", { cause: error });
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new TypeError("data directory must have an accessible parent directory.");
    }
    missingSegments.unshift(path.basename(candidate));
    candidate = parent;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function assertPrivateDataDirectory(workspace: string, dataDirectory: string): void {
  const relativePath = path.relative(workspace, dataDirectory);
  const contained = relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
  if (!contained) return;
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.some((segment) => (process.platform === "win32" ? segment.toLowerCase() : segment) === ".codeflow")) return;
  throw new TypeError("A data directory inside the workspace must be nested under .codeflow.");
}

async function captureWorkspaceSnapshot(workspace: string): Promise<CompletionSnapshot> {
  const head = await runGit(workspace, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
  const status = await runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "./"])
    .catch(() => "workspace-unversioned");
  const diff = head
    ? await runGit(workspace, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", "./"]).catch(() => "diff-unavailable")
    : "";
  return {
    codeVersion: head ? `git:${head.trim()}` : `workspace:${digest(normalizeWorkspaceIdentity(workspace)).slice("sha256:".length)}`,
    diffHash: digest(`${status}\u0000${diff}`),
  };
}

async function runGit(workspace: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd: workspace,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        env: gitEnvironment(),
      },
      (error, stdout) => error ? rejectPromise(error) : resolvePromise(stdout),
    );
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
  return environment;
}

async function recordUnexpectedFailure(
  journal: SqliteExecutionJournal,
  events: SqliteEventStore,
  identity: Parameters<SqliteExecutionJournal["append"]>[0]["identity"],
  error: unknown,
): Promise<RunReadonlySessionResult> {
  const details = unexpectedFailure(error);
  try {
    const facts = await events.list(identity.sessionId);
    const lifecycle = reduceAgentEvents(facts)?.status ?? null;
    if (lifecycle === null || !["COMPLETION_VERIFIED", "CANCELLED", "FAILED"].includes(lifecycle)) {
      await journal.append({ identity, type: "session.failed", error: details });
    }
  } catch {
    // Preserve the original stable failure when durable storage is unavailable.
  }
  return { status: "failed", outputText: null, modelAttempts: 0, toolCalls: 0, error: details };
}

function unexpectedFailure(error: unknown): StructuredError {
  return {
    category: "readonly_session_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    sideEffectStatus: "none",
    recovery: "Inspect the durable Session trace before starting another paid run.",
  };
}

function deterministicWorkspaceId(workspace: string): StableId {
  const bytes = createHash("sha256").update(`workspace-id:${normalizeWorkspaceIdentity(workspace)}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return stableIdSchema.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

function normalizeWorkspaceIdentity(workspace: string): string {
  const normalized = path.normalize(workspace);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
