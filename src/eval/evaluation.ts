import { z } from "zod";

import { budgetLimitsSchema } from "../policy/budget-contracts.js";
import { stableIdSchema } from "../shared/contracts.js";

export const EVALUATION_SUITE_SCHEMA_VERSION = 1;

export const evaluationLanguageSchema = z.enum(["typescript", "python", "go"]);
export type EvaluationLanguage = z.infer<typeof evaluationLanguageSchema>;

export const evaluationScenarioSchema = z.enum(["existing-repository-bug", "new-project-feature"]);
export type EvaluationScenario = z.infer<typeof evaluationScenarioSchema>;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const versionSchema = z.string().regex(/^[a-z][a-z0-9_-]*:\S+$/);
const relativePathSchema = z.string().min(1).refine(
  (value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) &&
    value.split(/[\\/]/u).every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "Expected a normalized relative path without traversal.",
);

export const fixtureRefSchema = z.object({
  fixtureId: stableIdSchema,
  version: versionSchema,
  snapshotHash: digestSchema,
  resetCommandId: versionSchema,
});
export type FixtureRef = z.infer<typeof fixtureRefSchema>;

export const verifierRefSchema = z.object({
  verifierId: stableIdSchema,
  version: versionSchema,
  artifactHash: digestSchema,
  kind: z.enum(["test", "build", "static", "safety", "trace"]),
});
export type VerifierRef = z.infer<typeof verifierRefSchema>;

export const evaluationTaskSchema = z.object({
  id: z.string().regex(/^e1-(typescript|python|go)-(bug|feature)$/),
  version: versionSchema,
  language: evaluationLanguageSchema,
  scenario: evaluationScenarioSchema,
  fixture: fixtureRefSchema,
  prompt: z.string().trim().min(1),
  visibleAcceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  hiddenVerifiers: z.array(verifierRefSchema).length(1),
  allowedActions: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  forbiddenActions: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  editablePaths: z.array(relativePathSchema).min(1),
  networkPolicy: z.literal("deny"),
  limits: budgetLimitsSchema,
}).superRefine((task, refinement) => {
  const scenarioId = task.scenario === "existing-repository-bug" ? "bug" : "feature";
  if (task.id !== `e1-${task.language}-${scenarioId}`) {
    refinement.addIssue({ code: "custom", path: ["id"], message: "Task ID must match its language and scenario." });
  }
  const forbidden = new Set(task.forbiddenActions);
  if (task.allowedActions.some((action) => forbidden.has(action))) {
    refinement.addIssue({ code: "custom", path: ["allowedActions"], message: "Allowed and forbidden actions must be disjoint." });
  }
});
export type EvaluationTask = z.infer<typeof evaluationTaskSchema>;

export const evaluationSuiteManifestSchema = z.object({
  schemaVersion: z.literal(EVALUATION_SUITE_SCHEMA_VERSION),
  suiteId: z.literal("e1-six-task-mvp"),
  version: versionSchema,
  isolation: z.literal("logical_workspace_boundary"),
  tasks: z.array(evaluationTaskSchema).length(6),
}).superRefine((suite, refinement) => {
  const taskIds = new Set<string>();
  const fixtureIds = new Set<string>();
  const verifierIds = new Set<string>();
  const cells = new Set<string>();

  for (const [index, task] of suite.tasks.entries()) {
    if (taskIds.has(task.id)) refinement.addIssue({ code: "custom", path: ["tasks", index, "id"], message: "Duplicate task ID." });
    if (fixtureIds.has(task.fixture.fixtureId)) refinement.addIssue({ code: "custom", path: ["tasks", index, "fixture", "fixtureId"], message: "Duplicate fixture ID." });
    taskIds.add(task.id);
    fixtureIds.add(task.fixture.fixtureId);
    cells.add(`${task.language}:${task.scenario}`);
    for (const verifier of task.hiddenVerifiers) {
      if (verifierIds.has(verifier.verifierId)) refinement.addIssue({ code: "custom", path: ["tasks", index, "hiddenVerifiers"], message: "Duplicate verifier ID." });
      verifierIds.add(verifier.verifierId);
    }
  }

  for (const language of evaluationLanguageSchema.options) {
    for (const scenario of evaluationScenarioSchema.options) {
      if (!cells.has(`${language}:${scenario}`)) {
        refinement.addIssue({ code: "custom", path: ["tasks"], message: `Missing E1 matrix cell ${language}/${scenario}.` });
      }
    }
  }
});
export type EvaluationSuiteManifest = z.infer<typeof evaluationSuiteManifestSchema>;

/** Legacy release-gate shape retained until the trusted C15 result contract is implemented. */
export interface EvaluationResult {
  readonly taskId: string;
  readonly passed: boolean;
  readonly safetyVetoes: readonly string[];
  readonly traceComplete: boolean;
  readonly durationMs: number;
  readonly costUsd: number;
}

/** @deprecated This D1 gate is not the C15 trusted release gate. */
export function passesMvpGate(results: readonly EvaluationResult[]): boolean {
  const passed = results.filter((result) => result.passed).length;
  return (
    results.length === 6 &&
    passed >= 5 &&
    results.every((result) => result.safetyVetoes.length === 0 && result.traceComplete)
  );
}
