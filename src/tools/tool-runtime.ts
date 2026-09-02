import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { ExecutionJournal, ExecutionLease } from "../events/execution-journal.js";
import { budgetDeltaSchema } from "../policy/budget-contracts.js";
import type { PermissionEngine } from "../policy/permission-engine.js";
import {
  OPERATION_BINDING_VERSION,
  approvalTokenSchema,
  operationBindingSchema,
  type ApprovalRecord,
  type ApprovalRepository,
  type ApprovalToken,
  type TaskAuthorization,
} from "../policy/permission-contracts.js";
import { createOperationHash } from "../policy/operation-hash.js";
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
import { canonicalJson, validateJsonValue, type JsonObject, type JsonValue } from "../shared/json.js";
import type { ArtifactReference, ArtifactWriter } from "../storage/storage.js";
import { inputTransformationSchema, resourceClaimSchema, type ToolRegistry } from "./tool-registry.js";
import type { AnyRegisteredToolDefinition, InputTransformation, ResourceClaim } from "./tool.js";
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
  readonly workspaceId: StableId;
  readonly authorizationVersion: string;
  readonly traceId?: StableId;
  readonly parentTaskId?: StableId | null;
  readonly actorId?: string;
  readonly taskAuthorization: TaskAuthorization | null;
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
  readonly artifactStore?: ArtifactWriter;
  readonly maxInlineBytes?: number;
  readonly observe?: (event: ToolRuntimeEvent) => void | Promise<void>;
  readonly journal?: ExecutionJournal;
  readonly approvalRepository?: Pick<ApprovalRepository, "get">;
}

export class ToolRuntime {
  readonly #artifactStore: ArtifactWriter | null;
  readonly #maxInlineBytes: number;
  readonly #observe: ((event: ToolRuntimeEvent) => void | Promise<void>) | null;
  readonly #journal: ExecutionJournal | null;
  readonly #approvalRepository: Pick<ApprovalRepository, "get"> | null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionEngine: PermissionEngine,
    options: ToolRuntimeOptions = {},
  ) {
    this.#artifactStore = options.artifactStore ?? null;
    this.#maxInlineBytes = options.maxInlineBytes ?? 32_000;
    this.#observe = options.observe ?? null;
    this.#journal = options.journal ?? null;
    this.#approvalRepository = options.approvalRepository ?? null;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return failure(request.toolName, "", 0, "unknown_tool", "Tool is not registered.", false, "failed", "none");
    }
    if (!tool.availability.available) {
      return failure(
        tool.name,
        "",
        0,
        "tool_unavailable",
        tool.availability.message ?? "Tool is unavailable in the current environment.",
        false,
        "failed",
        sideEffectBeforeExecution(tool.sideEffect),
        tool.availability.reasonCode === null ? null : `Resolve availability reason ${tool.availability.reasonCode} before retrying.`,
      );
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

    let requestedInputHash: string;
    let schemaTransformations: readonly InputTransformation[];
    try {
      requestedInputHash = digestJson(request.input);
      const parsedInputHash = digestJson(parsed.data);
      schemaTransformations = requestedInputHash === parsedInputHash ? [] : [{
        field: "$",
        ruleCode: "schema_parse_v1",
        beforeHash: requestedInputHash,
        afterHash: parsedInputHash,
      }];
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
        "Use JSON-serializable tool input.",
      );
    }

    let effectiveInput: unknown;
    let effectiveInputHash: string;
    let transformations: readonly InputTransformation[];
    let resourceClaims: readonly ResourceClaim[];
    try {
      const normalized = tool.normalizeInput(parsed.data);
      const effective = tool.inputSchema.safeParse(normalized.effectiveInput);
      if (!effective.success) {
        return failure(
          tool.name,
          "",
          0,
          "normalized_input_invalid",
          effective.error.issues.map((issue) => issue.message).join("; "),
          false,
          "failed",
          sideEffectBeforeExecution(tool.sideEffect),
        );
      }
      effectiveInputHash = digestJson(effective.data);
      const declaredTransformations = inputTransformationSchema.array().safeParse(normalized.transformations);
      if (
        !declaredTransformations.success ||
        !verifyDeclaredTransformations(parsed.data, effective.data, declaredTransformations.data)
      ) {
        return failure(tool.name, "", 0, "input_transformation_invalid", "Tool input transformations do not match the normalized input facts.", false, "failed", sideEffectBeforeExecution(tool.sideEffect));
      }
      const parsedClaims = resourceClaimSchema.array().min(1).safeParse(tool.claimResources(effective.data));
      if (!parsedClaims.success || new Set(parsedClaims.success ? parsedClaims.data.map((claim) => `${claim.scope}:${claim.mode}:${claim.key}`) : []).size !== (parsedClaims.success ? parsedClaims.data.length : 0)) {
        return failure(tool.name, "", 0, "resource_claim_invalid", "Tool resource claims are invalid or duplicated.", false, "failed", sideEffectBeforeExecution(tool.sideEffect));
      }
      effectiveInput = effective.data;
      transformations = [...schemaTransformations, ...declaredTransformations.data];
      resourceClaims = parsedClaims.data;
    } catch (error: unknown) {
      return failure(
        tool.name,
        "",
        0,
        "input_normalization_failed",
        error instanceof Error ? error.message : String(error),
        false,
        "failed",
        sideEffectBeforeExecution(tool.sideEffect),
      );
    }

    let operationHash: string;
    let binding: ReturnType<typeof operationBindingSchema.parse>;
    try {
      binding = operationBindingSchema.parse({
        bindingVersion: OPERATION_BINDING_VERSION,
        sessionId: request.sessionId,
        taskId: request.taskId,
        authorizationVersion: request.authorizationVersion,
        toolName: tool.name,
        toolVersion: tool.contract.version,
        inputSchemaHash: tool.contract.inputSchemaHash,
        normalizationVersion: tool.contract.normalizationVersion,
        effectiveInputHash,
        workspaceId: request.workspaceId,
        codeVersion: request.codeVersion,
        diffHash: request.diffHash ?? null,
        configVersion: request.configVersion,
      });
      operationHash = createOperationHash(binding);
    } catch (error: unknown) {
      return failure(
        tool.name,
        "",
        0,
        "operation_binding_invalid",
        error instanceof Error ? error.message : "The operation binding is invalid.",
        false,
        "failed",
        sideEffectBeforeExecution(tool.sideEffect),
        "Refresh the Session, workspace and tool contract before retrying.",
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
    let approvalRecord: ApprovalRecord | null = null;
    if (request.approvalToken) {
      const token = approvalTokenSchema.safeParse(request.approvalToken);
      if (!token.success) {
        const sideEffectStatus = sideEffectBeforeExecution(tool.sideEffect);
        return envelope(
          tool.name,
          operationHash,
          "denied",
          0,
          sideEffectStatus,
          null,
          null,
          {
            category: "approval_invalid",
            message: "The approval token does not match the current permission schema.",
            retryable: false,
            sideEffectStatus,
            recovery: "Request a new approval for the current operation binding.",
          },
        );
      }
      if (!this.#approvalRepository) {
        return failure(tool.name, operationHash, 0, "approval_repository_unavailable", "Durable approval evidence cannot be loaded.", false, "failed", sideEffectBeforeExecution(tool.sideEffect));
      }
      try {
        approvalRecord = await this.#approvalRepository.get(token.data.approvalId);
      } catch (error: unknown) {
        const details = {
          ...errorDetails(error, "approval_lookup_failed", "Durable approval evidence could not be loaded."),
          sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect),
        };
        return envelope(tool.name, operationHash, "failed", 0, details.sideEffectStatus, null, null, details);
      }
    }
    const permission = this.permissionEngine.evaluate(tool, {
      binding,
      taskAuthorization: request.taskAuthorization,
      approvalToken: request.approvalToken,
      approvalRecord,
    });

    if (permission.outcome === "confirm") {
      return envelope(tool.name, operationHash, "approval_required", 0, sideEffectBeforeExecution(tool.sideEffect), null, null, {
        category: permission.reasonCode,
        message: permission.reason,
        retryable: true,
        sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect),
        recovery: "Obtain an approval bound to this exact operation before retrying.",
      });
    }
    if (permission.outcome === "deny") {
      return envelope(tool.name, operationHash, "denied", 0, sideEffectBeforeExecution(tool.sideEffect), null, null, {
        category: permission.reasonCode,
        message: permission.reason,
        retryable: false,
        sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect),
        recovery: null,
      });
    }
    if (tool.sideEffect !== "none" && !this.#journal) {
      return failure(tool.name, operationHash, 0, "durable_journal_required", "Write tools require a durable execution journal before they can start.", false, "failed", "not_started");
    }

    let journalLease: ExecutionLease | null = null;
    if (this.#journal) {
      if (!request.traceId) {
        return failure(tool.name, operationHash, 0, "journal_context_missing", "Durable tool execution requires a traceId.", false);
      }
      try {
        const transformationFacts: readonly JsonObject[] = transformations.map((item) => ({
          field: item.field,
          ruleCode: item.ruleCode,
          beforeHash: item.beforeHash,
          afterHash: item.afterHash,
        }));
        const resourceFacts: readonly JsonObject[] = resourceClaims.map((item) => ({
          key: item.key,
          mode: item.mode,
          scope: item.scope,
        }));
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
          authorization: {
            risk: tool.risk,
            authorizationId: permission.authorizationId,
            approvalId: permission.approvalId,
          },
          approvalToConsume: permission.approvalId === null ? null : {
            approvalId: permission.approvalId,
            operationHash,
          },
          payload: {
            toolName: tool.name,
            toolContract: {
              name: tool.contract.name,
              version: tool.contract.version,
              inputSchemaHash: tool.contract.inputSchemaHash,
              outputSchemaHash: tool.contract.outputSchemaHash,
              normalizationVersion: tool.contract.normalizationVersion,
            },
            requestedInputHash,
            effectiveInputHash,
            transformations: transformationFacts,
            resourceClaims: resourceFacts,
          },
        });
      } catch (error: unknown) {
        const details = {
          ...errorDetails(error, "tool_journal_begin_failed", "The durable tool start could not be recorded."),
          sideEffectStatus: sideEffectBeforeExecution(tool.sideEffect),
        };
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
      const output = await tool.execute(effectiveInput, {
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
        tool,
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
        const status = error.details.sideEffectStatus === "unknown"
          ? "unknown"
          : error.details.category === "cancelled"
            ? "cancelled"
            : "failed";
        result = envelope(
          tool.name,
          operationHash,
          status,
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
    tool: AnyRegisteredToolDefinition,
    operationHash: string,
    durationMs: number,
    output: unknown,
    sessionId: StableId,
    sideEffectStatus: "none" | "applied",
  ): Promise<ToolResultEnvelope> {
    const parsedOutput = tool.outputSchema.safeParse(output);
    if (!parsedOutput.success) {
      return failure(
        tool.name,
        operationHash,
        durationMs,
        "invalid_tool_output",
        parsedOutput.error.issues.map((issue) => issue.message).join("; "),
        false,
        "failed",
        sideEffectStatus,
        "Fix the registered tool implementation or output schema before retrying.",
      );
    }
    const validated = validateJsonValue(parsedOutput.data);
    if (!validated.ok) {
      return failure(
        tool.name,
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
        tool.name,
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
        tool.name,
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
    return envelope(tool.name, operationHash, "completed", durationMs, sideEffectStatus, null, artifact, null);
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

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function verifyDeclaredTransformations(
  before: unknown,
  after: unknown,
  transformations: readonly InputTransformation[],
): boolean {
  const fields = new Set<string>();
  for (const transformation of transformations) {
    if (transformation.field === "$" || fields.has(transformation.field)) return false;
    fields.add(transformation.field);
    const beforeFact = resolveJsonPointer(before, transformation.field);
    const afterFact = resolveJsonPointer(after, transformation.field);
    if (!beforeFact.found || !afterFact.found) return false;
    if (
      digestJson(beforeFact.value) !== transformation.beforeHash ||
      digestJson(afterFact.value) !== transformation.afterHash ||
      transformation.beforeHash === transformation.afterHash
    ) return false;
  }

  const changedPointers = collectChangedPointers(before, after);
  return changedPointers.every((pointer) => transformations.some((transformation) => (
    pointer === transformation.field || pointer.startsWith(`${transformation.field}/`)
  )));
}

function resolveJsonPointer(value: unknown, pointer: string): { readonly found: boolean; readonly value?: unknown } {
  let current = value;
  for (const token of pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (isPlainObject(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function collectChangedPointers(before: unknown, after: unknown, pointer = "$"): readonly string[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((value, index) => collectChangedPointers(
      value,
      after[index],
      pointer === "$" ? `/${index}` : `${pointer}/${index}`,
    ));
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const childPointer = pointer === "$" ? `/${escaped}` : `${pointer}/${escaped}`;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) return [childPointer];
      return collectChangedPointers(before[key], after[key], childPointer);
    });
  }
  return [pointer];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
  );
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
