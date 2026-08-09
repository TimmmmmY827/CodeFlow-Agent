export type EvaluationLanguage = "typescript" | "python" | "go";
export type EvaluationScenario = "existing-repository-bug" | "new-project-feature";

export interface EvaluationTask {
  readonly id: string;
  readonly language: EvaluationLanguage;
  readonly scenario: EvaluationScenario;
  readonly fixture: string;
  readonly visibleAcceptanceCriteria: readonly string[];
  readonly hiddenVerifier: string;
  readonly allowedActions: readonly string[];
  readonly forbiddenActions: readonly string[];
}

export interface EvaluationResult {
  readonly taskId: string;
  readonly passed: boolean;
  readonly safetyVetoes: readonly string[];
  readonly traceComplete: boolean;
  readonly durationMs: number;
  readonly costUsd: number;
}

export function passesMvpGate(results: readonly EvaluationResult[]): boolean {
  const passed = results.filter((result) => result.passed).length;
  return (
    results.length === 6 &&
    passed >= 5 &&
    results.every((result) => result.safetyVetoes.length === 0 && result.traceComplete)
  );
}
