import { createHash } from "node:crypto";

import { z } from "zod";

import {
  artifactReferenceSchema,
  codeSnapshotSchema,
  stableIdSchema,
  structuredErrorSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
  type StableId,
} from "../shared/contracts.js";
import { canonicalJson } from "../shared/json.js";

export const COMPLETION_INTENT_SCHEMA_VERSION = 1;
export const COMPLETION_EVIDENCE_SCHEMA_VERSION = 1;
export const COMPLETION_GATE_CONTEXT_SCHEMA_VERSION = 1;
export const COMPLETION_DECISION_SCHEMA_VERSION = 1;
export const COMPLETION_GATE_VERSION = "completion-gate:v1";

const unverifiedItemSchema = z.object({
  description: z.string().trim().min(1).max(2_000),
  blocking: z.boolean(),
}).strict();

export const completionIntentSchema = z.object({
  schemaVersion: z.literal(COMPLETION_INTENT_SCHEMA_VERSION),
  observedCodeVersion: versionIdentifierSchema,
  observedDiffHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evidenceIds: z.array(stableIdSchema).max(256),
  unverifiedItems: z.array(unverifiedItemSchema).max(256),
  summary: z.string().trim().min(1).max(8_000),
}).strict().superRefine((intent, refinement) => {
  if (new Set(intent.evidenceIds).size !== intent.evidenceIds.length) {
    refinement.addIssue({
      code: "custom",
      message: "CompletionIntent evidenceIds must be unique.",
      path: ["evidenceIds"],
    });
  }
});

export type CompletionIntent = z.infer<typeof completionIntentSchema>;

const manualAcceptanceSchema = z.object({
  acceptedBy: z.string().trim().min(1).max(256),
  criteria: z.string().trim().min(1).max(4_000),
  acceptedAt: utcTimestampSchema,
}).strict();

export const verificationEvidenceSchema = z.object({
  schemaVersion: z.literal(COMPLETION_EVIDENCE_SCHEMA_VERSION),
  id: stableIdSchema,
  name: z.string().trim().min(1).max(512),
  kind: z.enum(["test", "build", "lint", "static", "manual", "runtime"]),
  required: z.boolean(),
  status: z.enum(["passed", "failed", "not_run"]),
  commandOrProcedure: z.string().trim().min(1).max(8_000).nullable(),
  artifact: artifactReferenceSchema.nullable(),
  artifactVerification: z.enum(["not_applicable", "verified", "missing_or_corrupt"]),
  codeVersion: versionIdentifierSchema,
  diffHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  producedBy: z.object({
    kind: z.enum(["tool", "user", "system"]),
    referenceId: stableIdSchema,
  }).strict(),
  manualAcceptance: manualAcceptanceSchema.nullable(),
  verifiedAt: utcTimestampSchema,
}).strict().superRefine((evidence, refinement) => {
  if (evidence.artifact === null && evidence.artifactVerification !== "not_applicable") {
    refinement.addIssue({
      code: "custom",
      message: "Evidence without an Artifact must use artifactVerification=not_applicable.",
      path: ["artifactVerification"],
    });
  }
  if (evidence.artifact !== null && evidence.artifactVerification === "not_applicable") {
    refinement.addIssue({
      code: "custom",
      message: "Evidence with an Artifact must include its trusted verification result.",
      path: ["artifactVerification"],
    });
  }
  if (evidence.kind === "manual") {
    if (evidence.producedBy.kind !== "user" || evidence.manualAcceptance === null) {
      refinement.addIssue({
        code: "custom",
        message: "Manual evidence requires a user producer and structured acceptance details.",
        path: ["manualAcceptance"],
      });
    }
  } else if (evidence.manualAcceptance !== null) {
    refinement.addIssue({
      code: "custom",
      message: "Only manual evidence may contain manual acceptance details.",
      path: ["manualAcceptance"],
    });
  }
});

export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

export const safetyVetoSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(4_000),
  eventId: stableIdSchema.nullable(),
  artifact: artifactReferenceSchema.nullable(),
}).strict().superRefine((veto, refinement) => {
  if (veto.eventId === null && veto.artifact === null) {
    refinement.addIssue({
      code: "custom",
      message: "A safety veto must reference an event or Artifact.",
      path: ["eventId"],
    });
  }
});

export type SafetyVeto = z.infer<typeof safetyVetoSchema>;

export const traceIntegrityReportSchema = z.object({
  complete: z.boolean(),
  eventCount: z.number().int().nonnegative(),
  sessionId: stableIdSchema.nullable(),
  firstGap: z.number().int().nonnegative().nullable(),
  firstInvalidSequence: z.number().int().nonnegative().nullable(),
  firstError: structuredErrorSchema.nullable(),
}).strict();

export const completionGateContextSchema = z.object({
  schemaVersion: z.literal(COMPLETION_GATE_CONTEXT_SCHEMA_VERSION),
  gateVersion: z.literal(COMPLETION_GATE_VERSION),
  sessionId: stableIdSchema,
  runId: stableIdSchema,
  snapshot: codeSnapshotSchema,
  traceIntegrity: traceIntegrityReportSchema,
  evidence: z.array(verificationEvidenceSchema).max(512),
  safetyVetoes: z.array(safetyVetoSchema).max(256),
  activeOperationIds: z.array(stableIdSchema).max(512),
  unknownOperationIds: z.array(stableIdSchema).max(512),
}).strict().superRefine((context, refinement) => {
  if (context.traceIntegrity.sessionId !== null && context.traceIntegrity.sessionId !== context.sessionId) {
    refinement.addIssue({
      code: "custom",
      message: "Trace integrity belongs to another Session.",
      path: ["traceIntegrity", "sessionId"],
    });
  }
  for (const [field, values] of [
    ["activeOperationIds", context.activeOperationIds],
    ["unknownOperationIds", context.unknownOperationIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      refinement.addIssue({ code: "custom", message: `${field} must be unique.`, path: [field] });
    }
  }
  const evidenceIds = context.evidence.map((item) => item.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    refinement.addIssue({ code: "custom", message: "Evidence IDs must be unique.", path: ["evidence"] });
  }
});

export type CompletionGateContext = z.infer<typeof completionGateContextSchema>;

export const completionReasonCodeSchema = z.enum([
  "invalid_completion_intent",
  "unsupported_completion_intent_version",
  "invalid_gate_context",
  "unsupported_gate_context_version",
  "gate_context_unavailable",
  "code_version_changed",
  "diff_hash_changed",
  "active_operations_present",
  "unknown_operations_present",
  "safety_veto_present",
  "trace_incomplete",
  "no_required_verifier",
  "evidence_not_found",
  "required_evidence_not_cited",
  "required_verifier_failed",
  "required_verifier_not_run",
  "evidence_snapshot_mismatch",
  "evidence_artifact_unverified",
  "passed_evidence_missing_proof",
  "blocking_unverified_item",
]);

export type CompletionReasonCode = z.infer<typeof completionReasonCodeSchema>;

export const completionReasonSchema = z.object({
  code: completionReasonCodeSchema,
  message: z.string().min(1),
  nextAction: z.string().min(1),
  evidenceId: stableIdSchema.nullable(),
  vetoCode: z.string().nullable(),
  operationIds: z.array(stableIdSchema),
}).strict();

export type CompletionReason = z.infer<typeof completionReasonSchema>;

export const completionDecisionSchema = z.object({
  schemaVersion: z.literal(COMPLETION_DECISION_SCHEMA_VERSION),
  gateVersion: z.literal(COMPLETION_GATE_VERSION),
  outcome: z.enum(["verified", "rejected"]),
  reasons: z.array(completionReasonSchema),
  intentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  contextHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  evidenceIds: z.array(stableIdSchema),
}).strict().superRefine((decision, refinement) => {
  if (decision.outcome === "verified" && decision.reasons.length > 0) {
    refinement.addIssue({ code: "custom", message: "A verified decision cannot contain rejection reasons.", path: ["reasons"] });
  }
  if (decision.outcome === "verified" && (decision.intentHash === null || decision.contextHash === null)) {
    refinement.addIssue({ code: "custom", message: "A verified decision requires intent and context hashes.", path: ["contextHash"] });
  }
  if (decision.outcome === "rejected" && decision.reasons.length === 0) {
    refinement.addIssue({ code: "custom", message: "A rejected decision requires at least one reason.", path: ["reasons"] });
  }
  if (new Set(decision.evidenceIds).size !== decision.evidenceIds.length) {
    refinement.addIssue({ code: "custom", message: "Decision evidence IDs must be unique.", path: ["evidenceIds"] });
  }
});

export type CompletionDecision = z.infer<typeof completionDecisionSchema>;

export interface CompletionGateContextRequest {
  readonly sessionId: StableId;
  readonly runId: StableId;
  readonly workspacePath: string;
  readonly configVersion: string;
}

export interface CompletionGateContextProvider {
  capture(request: CompletionGateContextRequest): Promise<CompletionGateContext>;
}

export class CompletionGate {
  evaluate(intentInput: unknown, contextInput: unknown): CompletionDecision {
    const intentVersion = readSchemaVersion(intentInput);
    if (intentVersion !== null && intentVersion !== COMPLETION_INTENT_SCHEMA_VERSION) {
      return rejectedDecision([
        reason(
          "unsupported_completion_intent_version",
          `Completion intent schema major version ${intentVersion} is not supported.`,
          `Migrate the intent to schema major version ${COMPLETION_INTENT_SCHEMA_VERSION}.`,
        ),
      ], null, null, []);
    }
    const parsedIntent = completionIntentSchema.safeParse(intentInput);
    if (!parsedIntent.success) {
      return rejectedDecision([
        reason(
          "invalid_completion_intent",
          `Completion intent is invalid: ${parsedIntent.error.issues.map((issue) => issue.message).join("; ")}`,
          "Submit a versioned intent containing the observed snapshot and trusted evidence IDs.",
        ),
      ], null, null, []);
    }

    const intent = parsedIntent.data;
    const intentHash = hashRecord(intent);
    const contextVersion = readSchemaVersion(contextInput);
    if (contextVersion !== null && contextVersion !== COMPLETION_GATE_CONTEXT_SCHEMA_VERSION) {
      return rejectedDecision([
        reason(
          "unsupported_gate_context_version",
          `CompletionGate context schema major version ${contextVersion} is not supported.`,
          `Migrate the trusted context to schema major version ${COMPLETION_GATE_CONTEXT_SCHEMA_VERSION}.`,
        ),
      ], intentHash, null, []);
    }
    const parsedContext = completionGateContextSchema.safeParse(contextInput);
    if (!parsedContext.success) {
      return rejectedDecision([
        reason(
          "invalid_gate_context",
          `Trusted CompletionGate context is invalid: ${parsedContext.error.issues.map((issue) => issue.message).join("; ")}`,
          "Repair the trusted context providers; do not substitute model-supplied facts.",
        ),
      ], intentHash, null, []);
    }

    const context = parsedContext.data;
    const contextHash = hashRecord(context);
    const reasons: CompletionReason[] = [];
    if (intent.observedCodeVersion !== context.snapshot.codeVersion) {
      reasons.push(reason("code_version_changed", "Code version changed after the completion intent was formed.", "Capture the latest snapshot and rerun required verification."));
    }
    if (intent.observedDiffHash !== context.snapshot.diffHash) {
      reasons.push(reason("diff_hash_changed", "Workspace diff changed after the completion intent was formed.", "Capture the latest diff and rerun required verification."));
    }
    if (context.activeOperationIds.length > 0) {
      reasons.push(reason("active_operations_present", "One or more operations are still active.", "Finish or cancel every active operation before completion.", { operationIds: context.activeOperationIds }));
    }
    if (context.unknownOperationIds.length > 0) {
      reasons.push(reason("unknown_operations_present", "One or more operations have an unknown side-effect state.", "Reconcile every unknown operation with a trusted provider before completion.", { operationIds: context.unknownOperationIds }));
    }
    for (const veto of context.safetyVetoes) {
      reasons.push(reason("safety_veto_present", `Safety veto [${veto.code}]: ${veto.description}`, "Resolve the referenced safety fact before completion.", { vetoCode: veto.code }));
    }
    if (!context.traceIntegrity.complete) {
      const detail = context.traceIntegrity.firstError?.message ?? "Critical trace facts are missing or invalid.";
      reasons.push(reason("trace_incomplete", `Critical trace is incomplete: ${detail}`, "Restore or account for the missing durable facts before completion."));
    }

    const citedIds = new Set(intent.evidenceIds);
    const evidenceById = new Map(context.evidence.map((item) => [item.id, item]));
    for (const evidenceId of intent.evidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        reasons.push(reason("evidence_not_found", `Trusted evidence ${evidenceId} was not found.`, "Rerun verification and cite the new trusted evidence ID.", { evidenceId }));
      }
    }

    const requiredEvidence = context.evidence.filter((item) => item.required);
    if (requiredEvidence.length === 0) {
      reasons.push(reason("no_required_verifier", "No system-recognized required verifier is available.", "Configure and run at least one required verifier."));
    }
    for (const evidence of requiredEvidence) {
      if (!citedIds.has(evidence.id)) {
        reasons.push(reason("required_evidence_not_cited", `Required evidence ${evidence.name} was not cited by the completion intent.`, "Cite every required trusted verifier result.", { evidenceId: evidence.id }));
      }
      if (evidence.status === "failed") {
        reasons.push(reason("required_verifier_failed", `Required verifier failed: ${evidence.name}.`, "Fix the failure and rerun this verifier.", { evidenceId: evidence.id }));
      } else if (evidence.status === "not_run") {
        reasons.push(reason("required_verifier_not_run", `Required verifier was not run: ${evidence.name}.`, "Run this verifier against the current snapshot.", { evidenceId: evidence.id }));
      }
    }

    for (const evidenceId of citedIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) continue;
      if (evidence.codeVersion !== context.snapshot.codeVersion || evidence.diffHash !== context.snapshot.diffHash) {
        reasons.push(reason("evidence_snapshot_mismatch", `Evidence ${evidence.name} is bound to a stale code snapshot.`, "Rerun this verification against the current code and diff.", { evidenceId }));
      }
      if (evidence.artifactVerification === "missing_or_corrupt") {
        reasons.push(reason("evidence_artifact_unverified", `Evidence Artifact for ${evidence.name} is missing or corrupt.`, "Regenerate and verify the Artifact before completion.", { evidenceId }));
      }
      if (evidence.status === "passed" && evidence.commandOrProcedure === null && evidence.artifact === null) {
        reasons.push(reason("passed_evidence_missing_proof", `Passed verifier ${evidence.name} has no procedure or Artifact evidence.`, "Record the verifier procedure or a verified Artifact.", { evidenceId }));
      }
    }

    for (const item of intent.unverifiedItems) {
      if (item.blocking) {
        reasons.push(reason("blocking_unverified_item", `Blocking item is unverified: ${item.description}`, "Verify this item or obtain explicit version-bound manual acceptance."));
      }
    }

    return reasons.length === 0
      ? {
          schemaVersion: COMPLETION_DECISION_SCHEMA_VERSION,
          gateVersion: COMPLETION_GATE_VERSION,
          outcome: "verified",
          reasons: [],
          intentHash,
          contextHash,
          evidenceIds: [...intent.evidenceIds],
        }
      : rejectedDecision(reasons, intentHash, contextHash, [...intent.evidenceIds]);
  }

  contextUnavailable(intentInput: unknown, message: string): CompletionDecision {
    const intentVersion = readSchemaVersion(intentInput);
    if (intentVersion !== null && intentVersion !== COMPLETION_INTENT_SCHEMA_VERSION) {
      return rejectedDecision([
        reason(
          "unsupported_completion_intent_version",
          `Completion intent schema major version ${intentVersion} is not supported.`,
          `Migrate the intent to schema major version ${COMPLETION_INTENT_SCHEMA_VERSION}.`,
        ),
      ], null, null, []);
    }
    const parsedIntent = completionIntentSchema.safeParse(intentInput);
    if (!parsedIntent.success) {
      return rejectedDecision([
        reason(
          "invalid_completion_intent",
          `Completion intent is invalid: ${parsedIntent.error.issues.map((issue) => issue.message).join("; ")}`,
          "Submit a versioned intent containing the observed snapshot and trusted evidence IDs.",
        ),
      ], null, null, []);
    }
    return rejectedDecision([
      reason("gate_context_unavailable", `Trusted CompletionGate context is unavailable: ${message}`, "Restore the trace, storage, snapshot, and operation providers before retrying."),
    ], hashRecord(parsedIntent.data), null, [...parsedIntent.data.evidenceIds]);
  }
}

function rejectedDecision(
  reasons: readonly CompletionReason[],
  intentHash: string | null,
  contextHash: string | null,
  evidenceIds: readonly StableId[],
): CompletionDecision {
  return {
    schemaVersion: COMPLETION_DECISION_SCHEMA_VERSION,
    gateVersion: COMPLETION_GATE_VERSION,
    outcome: "rejected",
    reasons: [...reasons],
    intentHash,
    contextHash,
    evidenceIds: [...evidenceIds],
  };
}

function reason(
  code: CompletionReasonCode,
  message: string,
  nextAction: string,
  details: {
    readonly evidenceId?: StableId;
    readonly vetoCode?: string;
    readonly operationIds?: readonly StableId[];
  } = {},
): CompletionReason {
  return {
    code,
    message,
    nextAction,
    evidenceId: details.evidenceId ?? null,
    vetoCode: details.vetoCode ?? null,
    operationIds: [...(details.operationIds ?? [])],
  };
}

export function hashCompletionRecord(value: CompletionIntent | CompletionGateContext): string {
  return hashRecord(value);
}

function hashRecord(value: CompletionIntent | CompletionGateContext): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function readSchemaVersion(input: unknown): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = (input as Readonly<Record<string, unknown>>).schemaVersion;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
