import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { z } from "zod";

import { isJsonValue, type JsonObject } from "./json.js";

export const stableIdSchema = z.string().uuid();
export type StableId = z.infer<typeof stableIdSchema>;

export const utcTimestampSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"), "Timestamp must use UTC (Z) notation.");
export type UtcTimestamp = z.infer<typeof utcTimestampSchema>;

export const schemaVersionSchema = z.number().int().positive();
export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

export const versionIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*:\S+$/, "Version identifiers must use a stable namespace:value form.");
export type VersionIdentifier = z.infer<typeof versionIdentifierSchema>;

export const sideEffectStatusSchema = z.enum([
  "none",
  "not_started",
  "applied",
  "unknown",
  "compensated",
]);
export type SideEffectStatus = z.infer<typeof sideEffectStatusSchema>;

export const toolRiskSchema = z.enum([
  "automatic",
  "task_authorized",
  "single_confirmation",
  "control",
]);
export type ToolRisk = z.infer<typeof toolRiskSchema>;

export const toolSideEffectSchema = z.enum(["none", "workspace_write", "external_write"]);
export type ToolSideEffect = z.infer<typeof toolSideEffectSchema>;

export const toolRetryPolicySchema = z.enum(["safe", "reconcile", "never"]);
export type ToolRetryPolicy = z.infer<typeof toolRetryPolicySchema>;

export const codeSnapshotSchema = z
  .object({
    workspacePath: z.string().min(1).refine(path.isAbsolute, "Workspace path must be absolute."),
    codeVersion: versionIdentifierSchema.nullable(),
    diffHash: z.string().min(1).nullable().default(null),
    configVersion: versionIdentifierSchema,
  })
  .superRefine((snapshot, refinement) => {
    if (snapshot.diffHash !== null && snapshot.codeVersion === null) {
      refinement.addIssue({
        code: "custom",
        message: "A diff hash requires a Git or controlled workspace code version.",
        path: ["codeVersion"],
      });
    }
  });
export type CodeSnapshot = z.infer<typeof codeSnapshotSchema>;

const jsonObjectSchema = z.custom<JsonObject>(
  (value) => isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === "object",
  "Expected a JSON object.",
);

export const usageRecordSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    durationMs: z.number().nonnegative().default(0),
    providerUsage: jsonObjectSchema.default({}),
  });
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const structuredErrorSchema = z
  .object({
    category: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
    message: z.string().min(1),
    retryable: z.boolean(),
    sideEffectStatus: sideEffectStatusSchema.default("none"),
    recovery: z.string().min(1).nullable(),
  });
export type StructuredError = z.infer<typeof structuredErrorSchema>;

export const artifactReferenceSchema = z
  .object({
    artifactId: stableIdSchema,
    relativePath: z.string().min(1),
    mediaType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    sensitivity: z.enum(["normal", "sensitive"]),
  });
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

export const pathReferenceSchema = z
  .object({
    normalizedPath: z.string().min(1).refine(path.isAbsolute, "Normalized path must be absolute."),
    displayPath: z.string().min(1),
  });
export type PathReference = z.infer<typeof pathReferenceSchema>;

export interface CancellationContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: UtcTimestamp | null;
}

export interface Clock {
  utcNow(): UtcTimestamp;
  monotonicNowMs(): number;
}

export const systemClock: Clock = {
  utcNow: () => createUtcTimestamp(),
  monotonicNowMs: () => performance.now(),
};

export function createStableId(): StableId {
  return stableIdSchema.parse(randomUUID());
}

export function createUtcTimestamp(date: Date = new Date()): UtcTimestamp {
  return utcTimestampSchema.parse(date.toISOString());
}

export function createCodeSnapshot(input: {
  readonly workspacePath: string;
  readonly codeVersion?: string | null;
  readonly diffHash?: string | null;
  readonly configVersion?: string;
}): CodeSnapshot {
  const workspacePath = z.string().trim().min(1).parse(input.workspacePath);
  return codeSnapshotSchema.parse({
    workspacePath: path.resolve(workspacePath),
    codeVersion: input.codeVersion ?? null,
    diffHash: input.diffHash ?? null,
    configVersion: input.configVersion ?? "config:unversioned",
  });
}

export function createPathReference(inputPath: string, basePath: string = process.cwd()): PathReference {
  const checkedInputPath = z.string().trim().min(1).parse(inputPath);
  const checkedBasePath = z.string().trim().min(1).parse(basePath);
  return pathReferenceSchema.parse({
    normalizedPath: path.resolve(checkedBasePath, checkedInputPath),
    displayPath: inputPath,
  });
}

export function createCancellationContext(
  signal: AbortSignal,
  deadlineAt: UtcTimestamp | null = null,
): CancellationContext {
  if (deadlineAt !== null) utcTimestampSchema.parse(deadlineAt);
  return { signal, deadlineAt };
}

export function elapsedMilliseconds(startedAt: number, endedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    throw new RangeError("Monotonic timestamps must be finite and nondecreasing.");
  }
  return endedAt - startedAt;
}

export function cancellationFailure(
  context: CancellationContext,
  now: Date = new Date(),
): StructuredError | null {
  if (context.signal.aborted) {
    return {
      category: "cancelled",
      message: "Operation was cancelled.",
      retryable: false,
      sideEffectStatus: "none",
      recovery: null,
    };
  }
  if (context.deadlineAt !== null && now.getTime() >= Date.parse(context.deadlineAt)) {
    return {
      category: "deadline_exceeded",
      message: "Operation deadline was exceeded.",
      retryable: false,
      sideEffectStatus: "none",
      recovery: null,
    };
  }
  return null;
}
