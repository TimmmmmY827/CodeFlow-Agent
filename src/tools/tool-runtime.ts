import { Buffer } from "node:buffer";

import type { ExecutionJournal, ExecutionLease } from "../events/execution-journal.js";
import { budgetDeltaSchema } from "../policy/budget-contracts.js";
import type { LegacyApprovalToken, PermissionEngine } from "../policy/permission-engine.js";
import { createLegacyOperationHash } from "../policy/operation-hash.js";
import {
  cancellationFailure,
  elapsedMilliseconds,
  structuredErrorSchema,
  systemClock,
  type SideEffectStatus,
  type StableId,
  type StructuredError,
  type UtcTimestamp,
} from "../shared/contracts.js";
import { validateJsonValue, type JsonValue } from "../shared/json.js";
import type { ArtifactReference, ArtifactWriter } from "../storage/storage.js";
import type { ToolRegistry } from "./tool-registry.js";
import { ToolExecutionError } from "./tool.js";

export type ToolRuntimeStatus =
  | "completed"
  | "failed"
  | "approval_required"
  | "denied"
  | "cancelled"
  | "unknown";

export type ToolRuntimeError = StructuredError;

export interface ToolResultEnvelope {
  readonly toolName: string;
  readonly operationHash: string;
  readonly status: ToolRuntimeStatus;
  readonly durationMs: number;
  readonly sideEffectStatus: SideEffectStatus;
  readonly output: JsonValue | null;
  readonly artifact: ArtifactReference | null;
  readonly error: ToolRuntimeError | null;
}

export interface ToolExecutionRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly workspace: string;
  readonly codeVersion: string | null;
  readonly diffHash?: string | null;
  readonly configVersion: string;
  readonly signal: AbortSignal;
  readonly deadlineAt?: UtcTimestamp | null;
  readonly sessionId: StableId;
  readonly taskId: StableId;
  readonly traceId?: StableId;
  readonly parentTaskId?: StableId | null;
  readonly actorId?: string;
  readonly taskWriteAuthorized: boolean;
  readonly approvalToken: LegacyApprovalToken | null;
}

export interface ToolRuntimeEvent {
  readonly phase: "started" | "finished";
  readonly toolName: string;
  readonly operationHash: string;
  readonly status: ToolRuntimeStatus | "running";
  readonly durationMs: number | null;
}

export interface ToolRuntimeOptions {
  readonly artifactStore?: ArtifactWriter;
  readonly maxInlineBytes?: number;
  readonly observe?: (event: ToolRuntimeEvent) => void | Promise<void>;
  readonly journal?: ExecutionJournal;
}

export class ToolRuntime {
  readonly #consumedApprovalIds = new Set<string>();
  readonly #artifactStore: ArtifactWriter | null;
  readonly #maxInlineBytes: number;
  readonly #observe: ((event: ToolRuntimeEvent) => void | Promise<void>) | null;
  readonly #journal: ExecutionJournal | null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionEngine: PermissionEngine,
    options: ToolRuntimeOptions = {},
  ) {
    this.#artifactStore = options.artifactStore ?? null;
    this.#maxInlineBytes = options.maxInlineBytes ?? 32_000;
    this.#observe = options.observe ?? null;
    this.#journal = options.journal ?? null;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return failure(request.toolName, "", 0, "unknown_tool", "Tool is not registered.", false, "failed", "none");
    }

    const parsed = tool.inputSchema.safeParse(request.input);
    if (!parsed.success) {
      return failure(
        tool.name,
        "",
        0,
        "invalid_input",
        parsed.error.issues.map((issue) => issue.message).join("; "),
        false,
        "failed",
        sideEffectBeforeExecution(tool.sideEffect),
      );
    }

    let operationHash: string;
    try {
      operationHash = createLegacyOperationHash({
        toolName: tool.name,
        input: parsed.data,
        codeVersion: request.codeVersion,
      });
    } catch (error: unknown) {
      return failure(
        tool.name,
        "",
        0,
        "not_json_serializable",
        error instanceof Error ? error.message : String(error),
        false,
        "failed",
        sideEffectBeforeExecution(tool.sideEffect),
        "Use a JSON-serializable tool input schema.",
      );
    }
    const cancellation = cancellationFailure({
      signal: request.signal,
      deadlineAt: request.deadlineAt ?? null,
    });
    if (cancellation) {
      return envelope(
        tool.name,
        operationHash,
        "cancelled",
        0,
        sideEffectBeforeExecution(tool.sideEffect),
        null,
        null,
        { ...cancellation, sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect) },
      );
    }
    const permission = this.permissionEngine.decide(tool, {
      taskWriteAuthorized: request.taskWriteAuthorized,
      operationHash,
      approvalToken: request.approvalToken,
    });

    if (permission.outcome === "confirm") {
      return envelope(tool.name, operationHash, "approval_required", 0, sideEffectBeforeExecution(tool.sideEffect), null, null, {
        category: "approval_required",
        message: permission.reason,
        retryable: true,
        sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect),
        recovery: "Obtain an approval bound to this exact operation before retrying.",
      });
    }
    if (permission.outcome === "deny") {
      return envelope(tool.name, operationHash, "denied", 0, sideEffectBeforeExecution(tool.sideEffect), null, null, {
        category: "permission_denied",
        message: permission.reason,
        retryable: false,
        sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect),
        recovery: null,
      });
    }
    if (
      tool.risk === "single_confirmation" &&
      request.approvalToken &&
      this.#consumedApprovalIds.has(request.approvalToken.approvalId)
    ) {
      return envelope(tool.name, operationHash, "denied", 0, sideEffectBeforeExecution(tool.sideEffect), null, null, {
        category: "approval_already_consumed",
        message: "The single-use approval has already been consumed.",
        retryable: false,
        sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect),
        recovery: "Reconcile the previous operation before requesting a new approval.",
      });
    }

    if (tool.risk === "single_confirmation" && request.approvalToken) {
      this.#consumedApprovalIds.add(request.approvalToken.approvalId);
    }

    let journalLease: ExecutionLease | null = null;
    if (this.#journal) {
      if (!request.traceId) {
        return failure(tool.name, operationHash, 0, "journal_context_missing", "Durable tool execution requires a traceId.", false);
      }
      try {
        journalLease = await this.#journal.begin({
          identity: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            traceId: request.traceId,
            workspacePath: request.workspace,
            codeVersion: request.codeVersion,
            diffHash: request.diffHash ?? null,
            configVersion: request.configVersion,
            ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
            ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
          },
          kind: "tool",
          name: tool.name,
          operationHash,
          estimate: budgetDeltaSchema.parse({ toolCalls: 1 }),
          payload: { toolName: tool.name },
        });
      } catch (error: unknown) {
        const details = errorDetails(error, "tool_journal_begin_failed", "The durable tool start could not be recorded.");
        return envelope(tool.name, operationHash, "failed", 0, details.sideEffectStatus, null, null, details);
      }
    }

    const cancellationAfterJournal = cancellationFailure({
      signal: request.signal,
      deadlineAt: request.deadlineAt ?? null,
    });
    if (cancellationAfterJournal) {
      const sideEffectStatus = sideEffectBeforeExecution(tool.sideEffect);
      const details = { ...cancellationAfterJournal, sideEffectStatus };
      if (this.#journal && journalLease) {
        try {
          await this.#journal.finish({
            lease: journalLease,
            status: "cancelled",
            actual: budgetDeltaSchema.parse({}),
            sideEffectStatus,
            error: details,
            payload: { toolName: tool.name, status: "cancelled" },
          });
        } catch (error: unknown) {
          return failure(tool.name, operationHash, 0, "tool_journal_finish_failed", error instanceof Error ? error.message : String(error), false);
        }
      }
      return envelope(tool.name, operationHash, "cancelled", 0, sideEffectStatus, null, null, details);
    }

    const startedAt = systemClock.monotonicNowMs();
    await this.#notify({
      phase: "started",
      toolName: tool.name,
      operationHash,
      status: "running",
      durationMs: null,
    });

    let result: ToolResultEnvelope;
    try {
      const output = await tool.execute(parsed.data, {
        workspace: request.workspace,
        codeVersion: request.codeVersion,
        configVersion: request.configVersion,
        signal: request.signal,
        deadlineAt: request.deadlineAt ?? null,
        sessionId: request.sessionId,
        taskId: request.taskId,
        diffHash: request.diffHash ?? null,
      });
      const durationMs = elapsedMilliseconds(startedAt, systemClock.monotonicNowMs());
      result = await this.#packageOutput(
        tool.name,
        operationHash,
        durationMs,
        output,
        request.sessionId,
        tool.sideEffect === "none" ? "none" : "applied",
      );
    } catch (error: unknown) {
      const durationMs = elapsedMilliseconds(startedAt, systemClock.monotonicNowMs());
      const cancelled = request.signal.aborted || isAbortError(error);
      const unknownSideEffect = tool.sideEffect !== "none";
      if (error instanceof ToolExecutionError) {
        result = envelope(
          tool.name,
          operationHash,
          error.details.category === "cancelled" ? "cancelled" : "failed",
          durationMs,
          error.details.sideEffectStatus,
          null,
          null,
          error.details,
        );
      } else {
      result = failure(
        tool.name,
        operationHash,
        durationMs,
        unknownSideEffect ? "side_effect_unknown" : cancelled ? "cancelled" : "tool_execution_failed",
        error instanceof Error ? error.message : String(error),
        !cancelled && tool.retryPolicy === "safe",
        unknownSideEffect ? "unknown" : cancelled ? "cancelled" : "failed",
        unknownSideEffect ? "unknown" : "none",
      );
      }
    }

    await this.#notify({
      phase: "finished",
      toolName: tool.name,
      operationHash,
      status: result.status,
      durationMs: result.durationMs,
    });

    if (this.#journal && journalLease) {
      try {
        await this.#journal.finish({
          lease: journalLease,
          status: result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed",
          actual: budgetDeltaSchema.parse({ toolCalls: 1, activeDurationMs: result.durationMs }),
          sideEffectStatus: result.sideEffectStatus,
          error: result.error,
          payload: {
            toolName: tool.name,
            status: result.status,
            artifactId: result.artifact?.artifactId ?? null,
          },
        });
      } catch (error: unknown) {
        const unknownSideEffect = tool.sideEffect !== "none" && result.sideEffectStatus !== "not_started";
        return failure(
          tool.name,
          operationHash,
          result.durationMs,
          "tool_journal_finish_failed",
          error instanceof Error ? error.message : String(error),
          !unknownSideEffect,
          unknownSideEffect ? "unknown" : "failed",
          unknownSideEffect ? "unknown" : "none",
          "Reconcile the durable execution journal before continuing the Session.",
        );
      }
    }
    return result;
  }

  async #packageOutput(
    toolName: string,
    operationHash: string,
    durationMs: number,
    output: unknown,
    sessionId: StableId,
    sideEffectStatus: "none" | "applied",
  ): Promise<ToolResultEnvelope> {
    const validated = validateJsonValue(output);
    if (!validated.ok) {
      return failure(
        toolName,
        operationHash,
        durationMs,
        validated.error.category,
        `${validated.error.message} at ${validated.error.path}`,
        false,
        "failed",
        sideEffectStatus,
        "Return a JSON-serializable tool result.",
      );
    }
    const serialized = JSON.stringify(validated.value);
    const content = Buffer.from(serialized, "utf8");
    if (content.byteLength <= this.#maxInlineBytes) {
      return envelope(
        toolName,
        operationHash,
        "completed",
        durationMs,
        sideEffectStatus,
        validated.value,
        null,
        null,
      );
    }
    if (!this.#artifactStore) {
      return failure(
        toolName,
        operationHash,
        durationMs,
        "artifact_store_unavailable",
        "Tool output exceeds the inline limit and no ArtifactStore is configured.",
        sideEffectStatus === "none",
        "failed",
        sideEffectStatus,
      );
    }

    const artifact = await this.#artifactStore.write(
      sessionId,
      "application/json",
      content,
      "normal",
    );
    return envelope(toolName, operationHash, "completed", durationMs, sideEffectStatus, null, artifact, null);
  }

  async #notify(event: ToolRuntimeEvent): Promise<void> {
    try {
      await this.#observe?.(event);
    } catch {
      // Observers are non-authoritative diagnostics and cannot wedge the
      // durable execution state machine.
    }
  }
}

function envelope(
  toolName: string,
  operationHash: string,
  status: ToolRuntimeStatus,
  durationMs: number,
  sideEffectStatus: ToolResultEnvelope["sideEffectStatus"],
  output: JsonValue | null,
  artifact: ArtifactReference | null,
  error: ToolRuntimeError | null,
): ToolResultEnvelope {
  return {
    toolName,
    operationHash,
    status,
    durationMs,
    sideEffectStatus,
    output,
    artifact,
    error,
  };
}

function failure(
  toolName: string,
  operationHash: string,
  durationMs: number,
  category: string,
  message: string,
  retryable: boolean,
  status: "failed" | "cancelled" | "unknown" = "failed",
  sideEffectStatus: ToolResultEnvelope["sideEffectStatus"] = "none",
  recovery: string | null = null,
): ToolResultEnvelope {
  return envelope(toolName, operationHash, status, durationMs, sideEffectStatus, null, null, {
    category,
    message,
    retryable,
    sideEffectStatus,
    recovery,
  });
}

function sideEffectBeforeExecution(sideEffect: "none" | "workspace_write" | "external_write"):
  | "none"
  | "not_started" {
  return sideEffect === "none" ? "none" : "not_started";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorDetails(error: unknown, category: string, message: string): StructuredError {
  if (typeof error === "object" && error !== null && "details" in error) {
    const details = (error as { readonly details?: unknown }).details;
    const parsed = structuredErrorSchema.safeParse(details);
    if (parsed.success) return parsed.data;
  }
  return {
    category,
    message: error instanceof Error ? `${message} ${error.message}` : message,
    retryable: false,
    sideEffectStatus: "none",
    recovery: "Restore durable storage and retry before executing the tool.",
  };
}
