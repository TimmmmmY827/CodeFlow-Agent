import { Buffer } from "node:buffer";

import type { PermissionEngine, ApprovalToken } from "../policy/permission-engine.js";
import { createOperationHash } from "../policy/operation-hash.js";
import type { ArtifactReference, ArtifactStore } from "../storage/storage.js";
import type { ToolRegistry } from "./tool-registry.js";

export type ToolRuntimeStatus =
  | "completed"
  | "failed"
  | "approval_required"
  | "denied"
  | "cancelled"
  | "unknown";

export interface ToolRuntimeError {
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolResultEnvelope {
  readonly toolName: string;
  readonly operationHash: string;
  readonly status: ToolRuntimeStatus;
  readonly durationMs: number;
  readonly sideEffectStatus: "none" | "not_started" | "applied" | "unknown";
  readonly output: unknown | null;
  readonly artifact: ArtifactReference | null;
  readonly error: ToolRuntimeError | null;
}

export interface ToolExecutionRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly workspace: string;
  readonly codeVersion: string | null;
  readonly configVersion: string;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskWriteAuthorized: boolean;
  readonly approvalToken: ApprovalToken | null;
}

export interface ToolRuntimeEvent {
  readonly phase: "started" | "finished";
  readonly toolName: string;
  readonly operationHash: string;
  readonly status: ToolRuntimeStatus | "running";
  readonly durationMs: number | null;
}

export interface ToolRuntimeOptions {
  readonly artifactStore?: ArtifactStore;
  readonly maxInlineBytes?: number;
  readonly observe?: (event: ToolRuntimeEvent) => void | Promise<void>;
}

export class ToolRuntime {
  readonly #consumedApprovalIds = new Set<string>();
  readonly #artifactStore: ArtifactStore | null;
  readonly #maxInlineBytes: number;
  readonly #observe: ((event: ToolRuntimeEvent) => void | Promise<void>) | null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionEngine: PermissionEngine,
    options: ToolRuntimeOptions = {},
  ) {
    this.#artifactStore = options.artifactStore ?? null;
    this.#maxInlineBytes = options.maxInlineBytes ?? 32_000;
    this.#observe = options.observe ?? null;
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

    const operationHash = createOperationHash({
      toolName: tool.name,
      input: parsed.data,
      codeVersion: request.codeVersion,
    });
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
      });
    }
    if (permission.outcome === "deny") {
      return envelope(tool.name, operationHash, "denied", 0, sideEffectBeforeExecution(tool.sideEffect), null, null, {
        category: "permission_denied",
        message: permission.reason,
        retryable: false,
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
      });
    }
    if (request.signal.aborted) {
      return failure(
        tool.name,
        operationHash,
        0,
        "cancelled",
        "Operation was cancelled.",
        false,
        "cancelled",
        sideEffectBeforeExecution(tool.sideEffect),
      );
    }

    if (tool.risk === "single_confirmation" && request.approvalToken) {
      this.#consumedApprovalIds.add(request.approvalToken.approvalId);
    }

    const startedAt = performance.now();
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
        sessionId: request.sessionId,
        taskId: request.taskId,
      });
      const durationMs = performance.now() - startedAt;
      result = await this.#packageOutput(
        tool.name,
        operationHash,
        durationMs,
        output,
        request.sessionId,
        tool.sideEffect === "none" ? "none" : "applied",
      );
    } catch (error: unknown) {
      const durationMs = performance.now() - startedAt;
      const cancelled = request.signal.aborted || isAbortError(error);
      const unknownSideEffect = tool.sideEffect !== "none";
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

    await this.#notify({
      phase: "finished",
      toolName: tool.name,
      operationHash,
      status: result.status,
      durationMs: result.durationMs,
    });
    return result;
  }

  async #packageOutput(
    toolName: string,
    operationHash: string,
    durationMs: number,
    output: unknown,
    sessionId: string,
    sideEffectStatus: "none" | "applied",
  ): Promise<ToolResultEnvelope> {
    const serialized = JSON.stringify(output) ?? "null";
    const content = Buffer.from(serialized, "utf8");
    if (content.byteLength <= this.#maxInlineBytes) {
      return envelope(toolName, operationHash, "completed", durationMs, sideEffectStatus, output, null, null);
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
    await this.#observe?.(event);
  }
}

function envelope(
  toolName: string,
  operationHash: string,
  status: ToolRuntimeStatus,
  durationMs: number,
  sideEffectStatus: ToolResultEnvelope["sideEffectStatus"],
  output: unknown | null,
  artifact: ArtifactReference | null,
  error: ToolRuntimeError | null,
): ToolResultEnvelope {
  return { toolName, operationHash, status, durationMs, sideEffectStatus, output, artifact, error };
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
): ToolResultEnvelope {
  return envelope(toolName, operationHash, status, durationMs, sideEffectStatus, null, null, {
    category,
    message,
    retryable,
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
