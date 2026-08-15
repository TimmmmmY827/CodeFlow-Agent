import { createHash } from "node:crypto";

import { CompletionGate, type CompletionClaim } from "../completion/completion-gate.js";
import { createAgentEvent, createEventContext } from "../events/agent-event.js";
import type { ExecutionIdentity, ExecutionJournal } from "../events/execution-journal.js";
import type { EventStore } from "../events/event-store.js";
import { checkTraceIntegrity } from "../events/state-reducer.js";
import { estimateDeepSeekCostUsd, priceDeepSeekUsage } from "../model/deepseek-pricing.js";
import { ModelAdapterError, type ModelAdapter, type ModelInputItem } from "../model/model-adapter.js";
import { budgetDeltaSchema } from "../policy/budget-contracts.js";
import { canonicalJson } from "../shared/json.js";
import { createStableId, structuredErrorSchema, type StableId, type StructuredError, type UtcTimestamp } from "../shared/contracts.js";
import type { CompletionSnapshotProvider } from "../tools/builtin/finish-task.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolRuntime } from "../tools/tool-runtime.js";

export interface CreateSessionRequest {
  readonly goal: string;
  readonly workspace: string;
}

export interface CreatedSession {
  readonly sessionId: StableId;
  readonly taskId: StableId;
  readonly traceId: StableId;
}

export interface RunReadonlySessionRequest extends ExecutionIdentity {
  readonly goal: string;
  readonly signal: AbortSignal;
  readonly deadlineAt?: UtcTimestamp | null;
}

export interface RunReadonlySessionResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly outputText: string | null;
  readonly modelAttempts: number;
  readonly toolCalls: number;
  readonly error: StructuredError | null;
}

export interface AgentEventLoopOptions {
  readonly modelAdapter: ModelAdapter;
  readonly toolRegistry: ToolRegistry;
  readonly toolRuntime: ToolRuntime;
  readonly journal: ExecutionJournal;
  readonly completionSnapshotProvider: CompletionSnapshotProvider;
  readonly completionGate?: CompletionGate;
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
}

export class AgentEventLoop {
  readonly #options: AgentEventLoopOptions | null;

  constructor(private readonly eventStore: EventStore, options?: AgentEventLoopOptions) {
    this.#options = options ?? null;
  }

  async createSession(request: CreateSessionRequest): Promise<CreatedSession> {
    const sessionId = createStableId();
    const taskId = createStableId();
    const traceId = createStableId();
    await this.eventStore.append(
      createAgentEvent({
        sessionId,
        taskId,
        traceId,
        sequence: 0,
        type: "session.created",
        context: createEventContext({ workspacePath: request.workspace }),
        payload: { goal: request.goal, workspace: request.workspace },
      }),
    );
    return { sessionId, taskId, traceId };
  }

  async runReadonlySession(request: RunReadonlySessionRequest): Promise<RunReadonlySessionResult> {
    const options = this.#options;
    if (!options) throw new Error("AgentEventLoop requires execution options before running a Session.");
    const maxSteps = options.maxSteps ?? 8;
    const maxOutputTokens = options.maxOutputTokens ?? 512;
    const completionGate = options.completionGate ?? new CompletionGate();
    const input: ModelInputItem[] = [
      {
        type: "message",
        role: "system",
        content: "Inspect the repository only through the supplied read-only tools. Do not reveal hidden reasoning. Return a concise evidence-based answer after at least one tool result.",
      },
      { type: "message", role: "user", content: request.goal },
    ];
    let modelAttempts = 0;
    let toolCalls = 0;

    await options.journal.append({ identity: request, type: "session.started", payload: { mode: "readonly_analysis" } });

    for (let step = 0; step < maxSteps; step += 1) {
      if (request.signal.aborted || deadlineExceeded(request.deadlineAt ?? null)) {
        await appendCancelled(options.journal, request);
        return { status: "cancelled", outputText: null, modelAttempts, toolCalls, error: cancelledError() };
      }

      const modelTools = options.toolRegistry.listForModel();
      // One UTF-16 code unit per token is deliberately conservative for mixed
      // Chinese/English prompts and includes the complete tool catalog.
      const estimatedInputTokens = canonicalJson({ input, tools: modelTools }).length;
      const estimatedCostUsd = estimateDeepSeekCostUsd(options.modelAdapter.model, estimatedInputTokens, maxOutputTokens);
      if (estimatedCostUsd === null) {
        const error = failureError("model_pricing_unknown", `No trusted local price exists for ${options.modelAdapter.model}.`, false, "Add a versioned official price before making a paid call.");
        await options.journal.append({ identity: request, type: "session.failed", error, payload: { model: options.modelAdapter.model } });
        return { status: "failed", outputText: null, modelAttempts, toolCalls, error };
      }

      const operationHash = hashOperation({ model: options.modelAdapter.model, input, maxOutputTokens, step });
      let lease;
      try {
        lease = await options.journal.begin({
          identity: request,
          kind: "model",
          name: options.modelAdapter.model,
          operationHash,
          estimate: budgetDeltaSchema.parse({
            steps: 1,
            inputTokens: estimatedInputTokens,
            outputTokens: maxOutputTokens,
            costUsd: estimatedCostUsd,
          }),
          payload: { provider: options.modelAdapter.provider, model: options.modelAdapter.model, attempt: modelAttempts + 1 },
        });
      } catch (error: unknown) {
        const details = journalFailure(error);
        await options.journal.append({ identity: request, type: "session.failed", error: details });
        return { status: "failed", outputText: null, modelAttempts, toolCalls, error: details };
      }
      modelAttempts += 1;

      if (request.signal.aborted || deadlineExceeded(request.deadlineAt ?? null)) {
        const error = cancelledError();
        await options.journal.finish({ lease, status: "cancelled", actual: budgetDeltaSchema.parse({}), sideEffectStatus: "none", error });
        await appendCancelled(options.journal, request);
        return { status: "cancelled", outputText: null, modelAttempts, toolCalls, error };
      }

      let response;
      try {
        response = await options.modelAdapter.generate({
          input,
          tools: modelTools,
          toolChoice: toolCalls === 0 ? "required" : "auto",
          maxOutputTokens,
          signal: request.signal,
          deadlineAt: request.deadlineAt ?? null,
        });
      } catch (error: unknown) {
        const details = modelFailure(error);
        const cancelled = details.category === "cancelled" || details.category === "deadline_exceeded";
        await options.journal.finish({
          lease,
          status: cancelled ? "cancelled" : "failed",
          actual: null,
          sideEffectStatus: "none",
          error: details,
          payload: { providerResponseId: error instanceof ModelAdapterError ? error.providerResponseId : null },
        });
        if (cancelled) {
          await appendCancelled(options.journal, request);
          return { status: "cancelled", outputText: null, modelAttempts, toolCalls, error: details };
        }
        await options.journal.append({ identity: request, type: "session.failed", error: details });
        return { status: "failed", outputText: null, modelAttempts, toolCalls, error: details };
      }

      const priced = priceDeepSeekUsage(response.model, response.usage);
      if (!priced) {
        const error = failureError("model_usage_unpriced", "Provider usage could not be reconciled with the trusted pricing table.", false, "Inspect provider usage before permitting another paid call.");
        await options.journal.finish({ lease, status: "failed", actual: null, sideEffectStatus: "none", error, payload: { responseId: response.responseId } });
        await options.journal.append({ identity: request, type: "session.failed", error });
        return { status: "failed", outputText: null, modelAttempts, toolCalls, error };
      }
      await options.journal.finish({
        lease,
        status: "completed",
        actual: budgetDeltaSchema.parse({
          steps: 1,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          activeDurationMs: response.usage.durationMs,
          costUsd: priced.costUsd,
        }),
        usage: { ...response.usage, costUsd: priced.costUsd },
        sideEffectStatus: "none",
        payload: {
          responseId: response.responseId,
          model: response.model,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          pricingVersion: priced.pricingVersion,
        },
      });

      if (response.toolCalls.length > 0) {
        input.push({ type: "assistant_tool_calls", content: response.outputText || null, calls: response.toolCalls });
        for (const call of response.toolCalls) {
          const result = await options.toolRuntime.execute({
            toolName: call.name,
            input: call.arguments,
            workspace: request.workspacePath,
            codeVersion: request.codeVersion,
            diffHash: request.diffHash,
            configVersion: request.configVersion,
            signal: request.signal,
            deadlineAt: request.deadlineAt ?? null,
            sessionId: request.sessionId,
            taskId: request.taskId,
            traceId: request.traceId,
            ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
            ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
            taskWriteAuthorized: false,
            approvalToken: null,
          });
          toolCalls += 1;
          input.push({ type: "tool_result", callId: call.callId, output: canonicalJson({ status: result.status, output: result.output, artifact: result.artifact, error: result.error }) });
          if (result.status !== "completed") {
            const error = result.error ?? failureError("tool_failed", `${call.name} did not complete.`, false, null);
            if (result.status === "cancelled") {
              await appendCancelled(options.journal, request);
              return { status: "cancelled", outputText: null, modelAttempts, toolCalls, error };
            }
            await options.journal.append({ identity: request, type: "session.failed", error, payload: { toolName: call.name } });
            return { status: "failed", outputText: null, modelAttempts, toolCalls, error };
          }
        }
        continue;
      }

      if (!response.outputText.trim()) {
        const error = failureError("model_empty_completion", "The model returned neither a tool call nor an answer.", false, "Retry with a model that returns explicit completion evidence.");
        await options.journal.append({ identity: request, type: "session.failed", error });
        return { status: "failed", outputText: null, modelAttempts, toolCalls, error };
      }

      await options.journal.append({ identity: request, type: "verification.started", payload: { verifier: "readonly_trace" } });
      const beforeVerification = checkTraceIntegrity(await this.eventStore.list(request.sessionId));
      const verificationPassed = beforeVerification.complete && toolCalls > 0;
      await options.journal.append({ identity: request, type: "verification.completed", payload: { passed: verificationPassed, verifier: "readonly_trace" } });
      if (!verificationPassed) {
        return {
          status: "failed",
          outputText: null,
          modelAttempts,
          toolCalls,
          error: beforeVerification.firstError ?? failureError("verification_failed", "The read-only trace did not contain tool evidence.", false, null),
        };
      }

      const snapshot = await options.completionSnapshotProvider.capture(request.workspacePath);
      const trace = checkTraceIntegrity(await this.eventStore.list(request.sessionId));
      const claim: CompletionClaim = {
        codeVersion: request.codeVersion ?? "workspace:unversioned",
        diffHash: request.diffHash ?? "sha256:unversioned",
        traceComplete: trace.complete,
        verification: [{ name: "readonly_trace", required: true, status: "passed", evidence: response.responseId }],
        unverifiedItems: [],
        safetyVetoes: [],
      };
      const decision = completionGate.evaluate(claim, snapshot);
      if (decision.outcome !== "verified") {
        const error = failureError("completion_rejected", decision.reasons.join("; "), false, "Refresh the code snapshot and verification evidence before retrying completion.");
        await options.journal.append({ identity: request, type: "session.failed", error, payload: { reasons: [...decision.reasons] } });
        return { status: "failed", outputText: null, modelAttempts, toolCalls, error };
      }
      await options.journal.append({ identity: request, type: "completion.claimed", payload: { responseId: response.responseId, verifier: "readonly_trace" } });
      await options.journal.append({ identity: request, type: "completion.verified", payload: { responseId: response.responseId } });
      return { status: "completed", outputText: response.outputText, modelAttempts, toolCalls, error: null };
    }

    const error = failureError("step_limit_reached", `The read-only loop reached its ${maxSteps}-step limit.`, false, "Increase the limit only after inspecting the trace for progress.");
    await options.journal.append({ identity: request, type: "session.failed", error });
    return { status: "failed", outputText: null, modelAttempts, toolCalls, error };
  }
}

async function appendCancelled(journal: ExecutionJournal, identity: ExecutionIdentity): Promise<void> {
  await journal.append({ identity, type: "session.cancelling", payload: { requestedBy: "control" } });
  await journal.append({ identity, type: "session.cancelled", payload: { reason: "cancelled" } });
}

function hashOperation(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

function deadlineExceeded(deadlineAt: UtcTimestamp | null): boolean {
  return deadlineAt !== null && Date.now() >= Date.parse(deadlineAt);
}

function modelFailure(error: unknown): StructuredError {
  if (error instanceof ModelAdapterError) {
    return {
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      sideEffectStatus: "none",
      recovery: error.recovery,
    };
  }
  return failureError("model_call_failed", error instanceof Error ? error.message : String(error), false, "Inspect the durable model.started fact before retrying.");
}

function journalFailure(error: unknown): StructuredError {
  if (typeof error === "object" && error !== null && "details" in error) {
    const details = (error as { readonly details?: unknown }).details;
    const parsed = structuredErrorSchema.safeParse(details);
    if (parsed.success) return parsed.data;
  }
  return failureError("execution_journal_failed", error instanceof Error ? error.message : String(error), false, "Restore durable storage before continuing the Session.");
}

function cancelledError(): StructuredError {
  return failureError("cancelled", "The Session was cancelled.", false, null);
}

function failureError(category: string, message: string, retryable: boolean, recovery: string | null): StructuredError {
  return { category, message, retryable, sideEffectStatus: "none", recovery };
}
