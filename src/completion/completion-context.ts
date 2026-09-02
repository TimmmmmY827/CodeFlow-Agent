import type { EventReader } from "../events/event-store.js";
import { checkTraceIntegrity } from "../events/state-reducer.js";
import type { ArtifactReference, CodeSnapshot, StableId, StructuredError } from "../shared/contracts.js";
import type { ArtifactStore } from "../storage/contracts.js";
import {
  COMPLETION_GATE_CONTEXT_SCHEMA_VERSION,
  COMPLETION_GATE_VERSION,
  completionGateContextSchema,
  verificationEvidenceSchema,
  type CompletionGateContext,
  type CompletionGateContextProvider,
  type CompletionGateContextRequest,
  type SafetyVeto,
  type VerificationEvidence,
} from "./completion-gate.js";

export interface CodeSnapshotProvider {
  capture(workspacePath: string, configVersion: string): Promise<CodeSnapshot>;
}

export type CompletionEvidenceCandidate = Omit<VerificationEvidence, "artifactVerification">;

export interface CompletionEvidenceProvider {
  list(sessionId: StableId, runId: StableId): Promise<readonly CompletionEvidenceCandidate[]>;
}

export interface CompletionSafetyProvider {
  list(sessionId: StableId, runId: StableId): Promise<readonly SafetyVeto[]>;
}

export interface CompletionOperationStatus {
  readonly activeOperationIds: readonly StableId[];
  readonly unknownOperationIds: readonly StableId[];
}

export interface CompletionOperationProvider {
  inspect(sessionId: StableId, runId: StableId): Promise<CompletionOperationStatus>;
}

export class CompletionContextError extends Error {
  readonly details: StructuredError;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompletionContextError";
    this.details = {
      category: "completion_context_unavailable",
      message,
      retryable: true,
      sideEffectStatus: "none",
      recovery: "Restore every trusted CompletionGate provider before retrying completion.",
    };
  }
}

/**
 * Builds trusted Gate input outside the pure CompletionGate. The individual
 * providers remain owned by their source components; this class only validates,
 * verifies Artifacts, and combines their current facts.
 */
export class TrustedCompletionContextProvider implements CompletionGateContextProvider {
  constructor(
    private readonly events: EventReader,
    private readonly snapshots: CodeSnapshotProvider,
    private readonly evidence: CompletionEvidenceProvider,
    private readonly safety: CompletionSafetyProvider,
    private readonly operations: CompletionOperationProvider,
    private readonly artifacts: Pick<ArtifactStore, "verify">,
  ) {}

  async capture(request: CompletionGateContextRequest): Promise<CompletionGateContext> {
    try {
      const [events, snapshot, evidence, safetyVetoes, operationStatus, expectedWorkspace] = await Promise.all([
        this.events.list(request.sessionId),
        this.snapshots.capture(request.workspacePath, request.configVersion),
        this.evidence.list(request.sessionId, request.runId),
        this.safety.list(request.sessionId, request.runId),
        this.operations.inspect(request.sessionId, request.runId),
        realpath(path.resolve(request.workspacePath)),
      ]);
      if (normalizePath(snapshot.workspacePath) !== normalizePath(expectedWorkspace)) {
        throw new CompletionContextError("The snapshot provider returned a different workspace identity.");
      }
      if (snapshot.configVersion !== request.configVersion) {
        throw new CompletionContextError("The snapshot provider returned a different configuration version.");
      }
      const verifiedEvidence = await Promise.all(
        evidence.map(async (item) => await verifyArtifact(request.sessionId, item, this.artifacts)),
      );
      return completionGateContextSchema.parse({
        schemaVersion: COMPLETION_GATE_CONTEXT_SCHEMA_VERSION,
        gateVersion: COMPLETION_GATE_VERSION,
        sessionId: request.sessionId,
        runId: request.runId,
        snapshot,
        traceIntegrity: checkTraceIntegrity(events),
        evidence: verifiedEvidence,
        safetyVetoes,
        activeOperationIds: [...operationStatus.activeOperationIds],
        unknownOperationIds: [...operationStatus.unknownOperationIds],
      });
    } catch (error: unknown) {
      if (error instanceof CompletionContextError) throw error;
      throw new CompletionContextError(
        `Trusted CompletionGate context could not be assembled: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

async function verifyArtifact(
  sessionId: StableId,
  evidence: CompletionEvidenceCandidate,
  artifacts: Pick<ArtifactStore, "verify">,
): Promise<VerificationEvidence> {
  if (evidence.artifact === null) {
    return verificationEvidenceSchema.parse({ ...evidence, artifactVerification: "not_applicable" });
  }
  const verified = await safelyVerify(artifacts, sessionId, evidence.artifact);
  return verificationEvidenceSchema.parse({
    ...evidence,
    artifactVerification: verified ? "verified" : "missing_or_corrupt",
  });
}

async function safelyVerify(
  artifacts: Pick<ArtifactStore, "verify">,
  sessionId: StableId,
  reference: ArtifactReference,
): Promise<boolean> {
  try {
    return await artifacts.verify(sessionId, reference);
  } catch {
    return false;
  }
}
import { realpath } from "node:fs/promises";
import path from "node:path";
