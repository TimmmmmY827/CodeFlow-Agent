import { randomUUID } from "node:crypto";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TrustedCompletionContextProvider } from "../src/completion/completion-context.js";
import {
  COMPLETION_EVIDENCE_SCHEMA_VERSION,
  COMPLETION_GATE_CONTEXT_SCHEMA_VERSION,
  COMPLETION_GATE_VERSION,
  COMPLETION_INTENT_SCHEMA_VERSION,
  CompletionGate,
  completionDecisionSchema,
  verificationEvidenceSchema,
  type CompletionGateContext,
  type CompletionIntent,
  type VerificationEvidence,
} from "../src/completion/completion-gate.js";
import { createAgentEvent, createEventContext } from "../src/events/agent-event.js";
import { InMemoryEventStore } from "../src/events/event-store.js";
import { E1FixtureHarness } from "../src/eval/fixture-harness.js";
import type { ArtifactReference } from "../src/shared/contracts.js";
import { createFinishTaskTool } from "../src/tools/builtin/finish-task.js";
import { registerFinishTaskTool } from "../src/tools/builtin/finish-task.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const CODE_VERSION = "git:abc123";
const DIFF_HASH = `sha256:${"d".repeat(64)}`;
const NOW = "2026-09-02T00:00:00.000Z";

describe("CompletionGate", () => {
  it("verifies only an intent whose cited trusted evidence matches the current context", () => {
    const fixture = validFixture();
    const result = new CompletionGate().evaluate(fixture.intent, fixture.context);

    expect(result).toMatchObject({
      schemaVersion: 1,
      gateVersion: COMPLETION_GATE_VERSION,
      outcome: "verified",
      reasons: [],
      evidenceIds: [fixture.evidence.id],
    });
    expect(result.intentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(completionDecisionSchema.parse(result)).toEqual(result);
  });

  it.each([
    ["code version", (fixture: Fixture) => ({ ...fixture, intent: { ...fixture.intent, observedCodeVersion: "git:older" } }), "code_version_changed"],
    ["diff", (fixture: Fixture) => ({ ...fixture, intent: { ...fixture.intent, observedDiffHash: `sha256:${"a".repeat(64)}` } }), "diff_hash_changed"],
    ["trace", (fixture: Fixture) => ({ ...fixture, context: { ...fixture.context, traceIntegrity: { ...fixture.context.traceIntegrity, complete: false, firstGap: 1, firstError: structuredFailure("trace_incomplete") } } }), "trace_incomplete"],
    ["active operation", (fixture: Fixture) => ({ ...fixture, context: { ...fixture.context, activeOperationIds: [randomUUID()] } }), "active_operations_present"],
    ["unknown operation", (fixture: Fixture) => ({ ...fixture, context: { ...fixture.context, unknownOperationIds: [randomUUID()] } }), "unknown_operations_present"],
    ["safety veto", (fixture: Fixture) => ({ ...fixture, context: { ...fixture.context, safetyVetoes: [{ code: "unapproved_external_write", description: "Unapproved write", eventId: randomUUID(), artifact: null }] } }), "safety_veto_present"],
    ["blocking item", (fixture: Fixture) => ({ ...fixture, intent: { ...fixture.intent, unverifiedItems: [{ description: "User acceptance", blocking: true }] } }), "blocking_unverified_item"],
    ["failed verifier", (fixture: Fixture) => withEvidence(fixture, { status: "failed" }), "required_verifier_failed"],
    ["not-run verifier", (fixture: Fixture) => withEvidence(fixture, { status: "not_run" }), "required_verifier_not_run"],
    ["stale evidence", (fixture: Fixture) => withEvidence(fixture, { diffHash: `sha256:${"b".repeat(64)}` }), "evidence_snapshot_mismatch"],
    ["corrupt Artifact", (fixture: Fixture) => withEvidence(fixture, { artifact: artifact(), artifactVerification: "missing_or_corrupt" }), "evidence_artifact_unverified"],
    ["missing proof", (fixture: Fixture) => withEvidence(fixture, { commandOrProcedure: null }), "passed_evidence_missing_proof"],
  ] as const)("rejects a %s with a stable reason code", (_label, mutate, expectedCode) => {
    const changed = mutate(validFixture());
    const result = new CompletionGate().evaluate(changed.intent, changed.context);

    expect(result.outcome).toBe("rejected");
    expect(result.reasons.map((item) => item.code)).toContain(expectedCode);
    expect(result.reasons.every((item) => item.nextAction.length > 0)).toBe(true);
  });

  it("does not let an intent omit a failing required verifier or cite invented evidence", () => {
    const fixture = validFixture();
    const inventedId = randomUUID();
    const result = new CompletionGate().evaluate(
      { ...fixture.intent, evidenceIds: [inventedId] },
      { ...fixture.context, evidence: [{ ...fixture.evidence, status: "failed" }] },
    );

    expect(result.reasons.map((item) => item.code)).toEqual(expect.arrayContaining([
      "evidence_not_found",
      "required_evidence_not_cited",
      "required_verifier_failed",
    ]));
  });

  it("rejects model-supplied trace, evidence and safety fields instead of treating them as facts", () => {
    const fixture = validFixture();
    const maliciousIntent = {
      ...fixture.intent,
      traceIntegrity: { complete: true },
      evidence: [fixture.evidence],
      safetyVetoes: [],
      activeOperationIds: [],
    };

    const result = new CompletionGate().evaluate(maliciousIntent, fixture.context);

    expect(result).toMatchObject({
      outcome: "rejected",
      reasons: [{ code: "invalid_completion_intent" }],
      contextHash: null,
    });
  });

  it("distinguishes unsupported schema majors from malformed records", () => {
    const fixture = validFixture();
    const gate = new CompletionGate();

    expect(gate.evaluate({ ...fixture.intent, schemaVersion: 2 }, fixture.context).reasons[0]?.code)
      .toBe("unsupported_completion_intent_version");
    expect(gate.evaluate(fixture.intent, { ...fixture.context, schemaVersion: 2 }).reasons[0]?.code)
      .toBe("unsupported_gate_context_version");
  });

  it("requires structured, version-bound manual acceptance", () => {
    const fixture = validFixture();
    const invalid = {
      ...fixture.evidence,
      kind: "manual",
      producedBy: { kind: "system", referenceId: randomUUID() },
      manualAcceptance: null,
    };

    expect(verificationEvidenceSchema.safeParse(invalid).success).toBe(false);
    expect(verificationEvidenceSchema.parse({
      ...invalid,
      producedBy: { kind: "user", referenceId: randomUUID() },
      manualAcceptance: { acceptedBy: "reviewer", criteria: "The requested interaction works", acceptedAt: NOW },
    })).toMatchObject({ kind: "manual", manualAcceptance: { acceptedBy: "reviewer" } });
  });

  it("deterministically replays completion rules for all six E1 tasks", async () => {
    const manifest = await new E1FixtureHarness().validate();
    const gate = new CompletionGate();

    expect(manifest.tasks).toHaveLength(6);
    for (const task of manifest.tasks) {
      const fixture = validFixture();
      const intent = { ...fixture.intent, summary: `Verified ${task.id}` };
      expect(gate.evaluate(intent, fixture.context)).toEqual(gate.evaluate(intent, fixture.context));
      expect(gate.evaluate(intent, fixture.context).outcome).toBe("verified");
    }
  });
});

describe("trusted completion context", () => {
  it("re-verifies Artifact evidence and exposes corruption to the pure gate", async () => {
    const fixture = validFixture();
    const events = await validEvents(fixture.context.sessionId, fixture.context.runId);
    const verify = vi.fn(async () => false);
    const provider = new TrustedCompletionContextProvider(
      events,
      { capture: async () => fixture.context.snapshot },
      { list: async () => [{ ...fixture.evidence, artifact: artifact(), artifactVerification: "verified" }] },
      { list: async () => [] },
      { inspect: async () => ({ activeOperationIds: [], unknownOperationIds: [] }) },
      { verify },
    );

    const context = await provider.capture({
      sessionId: fixture.context.sessionId,
      runId: fixture.context.runId,
      workspacePath: fixture.context.snapshot.workspacePath,
      configVersion: fixture.context.snapshot.configVersion,
    });

    expect(verify).toHaveBeenCalledOnce();
    expect(context.evidence[0]?.artifactVerification).toBe("missing_or_corrupt");
    const result = new CompletionGate().evaluate(fixture.intent, context);
    expect(result.reasons.map((item) => item.code)).toContain("evidence_artifact_unverified");
  });

  it("fails closed through finish_task when trusted context assembly fails", async () => {
    const fixture = validFixture();
    const tool = createFinishTaskTool({ capture: async () => { throw new Error("storage offline"); } });

    const result = await tool.execute(fixture.intent, executionContext(fixture));

    expect(tool).toMatchObject({ name: "finish_task", version: "tool:finish_task@2.0.0", risk: "control", sideEffect: "none" });
    expect(result).toMatchObject({
      outcome: "rejected",
      reasons: [{ code: "gate_context_unavailable" }],
      contextHash: null,
    });
  });

  it("passes a system-supplied context through finish_task", async () => {
    const fixture = validFixture();
    const tool = createFinishTaskTool({ capture: async () => fixture.context });

    await expect(tool.execute(fixture.intent, executionContext(fixture))).resolves.toMatchObject({ outcome: "verified" });
  });

  it("registers finish_task with its versioned model-visible contract", () => {
    const fixture = validFixture();
    const registry = new ToolRegistry();
    registerFinishTaskTool(registry, { capture: async () => fixture.context });

    expect(registry.get("finish_task")).toMatchObject({
      contract: { name: "finish_task", version: "tool:finish_task@2.0.0" },
    });
    expect(registry.listForModel()).toEqual([
      expect.objectContaining({ name: "finish_task", strict: false }),
    ]);
  });
});

interface Fixture {
  readonly intent: CompletionIntent;
  readonly evidence: VerificationEvidence;
  readonly context: CompletionGateContext;
}

function validFixture(): Fixture {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const evidence: VerificationEvidence = {
    schemaVersion: COMPLETION_EVIDENCE_SCHEMA_VERSION,
    id: randomUUID(),
    name: "unit tests",
    kind: "test",
    required: true,
    status: "passed",
    commandOrProcedure: "pnpm test",
    artifact: null,
    artifactVerification: "not_applicable",
    codeVersion: CODE_VERSION,
    diffHash: DIFF_HASH,
    producedBy: { kind: "tool", referenceId: randomUUID() },
    manualAcceptance: null,
    verifiedAt: NOW,
  };
  return {
    evidence,
    intent: {
      schemaVersion: COMPLETION_INTENT_SCHEMA_VERSION,
      observedCodeVersion: CODE_VERSION,
      observedDiffHash: DIFF_HASH,
      evidenceIds: [evidence.id],
      unverifiedItems: [],
      summary: "Implemented and verified the requested change.",
    },
    context: {
      schemaVersion: COMPLETION_GATE_CONTEXT_SCHEMA_VERSION,
      gateVersion: COMPLETION_GATE_VERSION,
      sessionId,
      runId,
      snapshot: {
        workspacePath: path.resolve(process.cwd()),
        codeVersion: CODE_VERSION,
        diffHash: DIFF_HASH,
        configVersion: "config:test",
      },
      traceIntegrity: {
        complete: true,
        eventCount: 2,
        sessionId,
        firstGap: null,
        firstInvalidSequence: null,
        firstError: null,
      },
      evidence: [evidence],
      safetyVetoes: [],
      activeOperationIds: [],
      unknownOperationIds: [],
    },
  };
}

function withEvidence(fixture: Fixture, change: Partial<VerificationEvidence>): Fixture {
  const evidence = { ...fixture.evidence, ...change } as VerificationEvidence;
  return { ...fixture, evidence, context: { ...fixture.context, evidence: [evidence] } };
}

function structuredFailure(category: string) {
  return {
    category,
    message: "Trace is incomplete.",
    retryable: false,
    sideEffectStatus: "none" as const,
    recovery: "Restore missing events.",
  };
}

function artifact(): ArtifactReference {
  return {
    artifactId: randomUUID(),
    relativePath: `${randomUUID()}.log`,
    mediaType: "text/plain",
    byteLength: 4,
    sha256: `sha256:${"a".repeat(64)}`,
    sensitivity: "normal",
  };
}

async function validEvents(sessionId: string, taskId: string): Promise<InMemoryEventStore> {
  const events = new InMemoryEventStore();
  const traceId = randomUUID();
  const context = createEventContext({ workspacePath: path.resolve(process.cwd()), configVersion: "config:test" });
  await events.append(createAgentEvent({ sessionId, taskId, traceId, sequence: 0, type: "session.created", context, payload: { goal: "test" }, occurredAt: NOW }));
  await events.append(createAgentEvent({ sessionId, taskId, traceId, sequence: 1, type: "session.started", context, occurredAt: NOW }));
  return events;
}

function executionContext(fixture: Fixture) {
  return {
    workspace: fixture.context.snapshot.workspacePath,
    codeVersion: fixture.context.snapshot.codeVersion,
    diffHash: fixture.context.snapshot.diffHash,
    configVersion: fixture.context.snapshot.configVersion,
    signal: new AbortController().signal,
    deadlineAt: null,
    sessionId: fixture.context.sessionId,
    taskId: fixture.context.runId,
  };
}
