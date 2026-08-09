import { z } from "zod";

import type { CodeSnapshot } from "../shared/contracts.js";

export const completionClaimSchema = z.object({
  codeVersion: z.string().min(1),
  diffHash: z.string().min(1),
  traceComplete: z.boolean(),
  verification: z
    .array(
      z.object({
        name: z.string().min(1),
        required: z.boolean(),
        status: z.enum(["passed", "failed", "not_run"]),
        evidence: z.string().min(1).nullable(),
      }),
    )
    .min(1),
  unverifiedItems: z.array(
    z.object({
      description: z.string().min(1),
      blocking: z.boolean(),
    }),
  ),
  safetyVetoes: z.array(z.string().min(1)),
});

export type CompletionClaim = z.infer<typeof completionClaimSchema>;

export interface CompletionSnapshot {
  readonly codeVersion: NonNullable<CodeSnapshot["codeVersion"]>;
  readonly diffHash: NonNullable<CodeSnapshot["diffHash"]>;
}

export interface CompletionDecision {
  readonly outcome: "verified" | "rejected";
  readonly reasons: readonly string[];
}

export class CompletionGate {
  evaluate(claimInput: unknown, snapshot: CompletionSnapshot): CompletionDecision {
    const parsed = completionClaimSchema.safeParse(claimInput);
    if (!parsed.success) {
      return {
        outcome: "rejected",
        reasons: parsed.error.issues.map((issue) => `invalid claim: ${issue.message}`),
      };
    }

    const claim = parsed.data;
    const reasons: string[] = [];
    if (claim.codeVersion !== snapshot.codeVersion) reasons.push("code version changed after the claim");
    if (claim.diffHash !== snapshot.diffHash) reasons.push("diff changed after the claim");
    if (!claim.traceComplete) reasons.push("critical trace is incomplete");
    if (claim.safetyVetoes.length > 0) reasons.push(...claim.safetyVetoes.map((item) => `safety veto: ${item}`));
    if (!claim.verification.some((item) => item.required)) reasons.push("no required verifier was supplied");
    for (const item of claim.verification) {
      if (item.required && item.status !== "passed") {
        reasons.push(`required verifier did not pass: ${item.name}`);
      }
      if (item.status === "passed" && !item.evidence) {
        reasons.push(`passed verifier has no evidence: ${item.name}`);
      }
    }
    for (const item of claim.unverifiedItems) {
      if (item.blocking) reasons.push(`blocking item is unverified: ${item.description}`);
    }

    return reasons.length === 0
      ? { outcome: "verified", reasons: [] }
      : { outcome: "rejected", reasons };
  }
}
