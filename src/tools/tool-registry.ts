import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson, validateJsonValue, type JsonObject } from "../shared/json.js";
import { utcTimestampSchema, versionIdentifierSchema, type UtcTimestamp } from "../shared/contracts.js";
import type {
  AnyRegisteredToolDefinition,
  AnyToolDefinition,
  RegisteredToolDefinition,
  ToolAvailability,
  ToolContractIdentity,
  ToolDefinition,
} from "./tool.js";

export const TOOL_CATALOG_SCHEMA_VERSION = 1;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
export const toolAvailabilitySchema = z.object({
  available: z.boolean(),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).nullable(),
  message: z.string().trim().min(1).max(1_024).nullable(),
  checkedAt: utcTimestampSchema,
}).strict().superRefine((availability, context) => {
  const unavailable = !availability.available;
  if (unavailable !== (availability.reasonCode !== null) || unavailable !== (availability.message !== null)) {
    context.addIssue({
      code: "custom",
      message: "Unavailable tools require both reasonCode and message; available tools require neither.",
    });
  }
});

export const inputTransformationSchema = z.object({
  field: z.string().trim().min(1).max(256).refine(
    (value) => value === "$" || (value.startsWith("/") && !/~(?![01])/u.test(value)),
    "Transformation fields must use an RFC 6901 JSON Pointer; $ is reserved for Runtime schema parsing.",
  ),
  ruleCode: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  beforeHash: digestSchema,
  afterHash: digestSchema,
}).strict();

export const resourceClaimSchema = z.object({
  key: z.string().trim().min(1).max(1_024),
  mode: z.enum(["read", "write"]),
  scope: z.enum(["workspace", "path", "repository", "provider_object"]),
}).strict();

export const toolContractIdentitySchema = z.object({
  name: toolNameSchema,
  version: versionIdentifierSchema,
  inputSchemaHash: digestSchema,
  outputSchemaHash: digestSchema,
  normalizationVersion: versionIdentifierSchema,
}).strict();

export const toolCatalogManifestSchema = z.object({
  schemaVersion: z.literal(TOOL_CATALOG_SCHEMA_VERSION),
  catalogHash: digestSchema,
  tools: z.array(z.object({
    contract: toolContractIdentitySchema,
    availability: toolAvailabilitySchema,
  }).strict()),
  generatedAt: utcTimestampSchema,
}).strict();

export interface ToolCatalogEntry {
  readonly contract: ToolContractIdentity;
  readonly availability: ToolAvailability;
}

export interface ToolCatalogManifest {
  readonly schemaVersion: typeof TOOL_CATALOG_SCHEMA_VERSION;
  readonly catalogHash: string;
  readonly tools: readonly ToolCatalogEntry[];
  readonly generatedAt: UtcTimestamp;
}

export interface ProjectedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: false;
}

export class ToolRegistry {
  readonly #tools = new Map<string, AnyRegisteredToolDefinition>();
  #manifest: ToolCatalogManifest | null = null;

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.#manifest) throw new Error("Tool registry is sealed and cannot accept new definitions.");
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }
    const registered = registerTool(tool);
    this.#tools.set(tool.name, registered);
  }

  get(name: string): AnyRegisteredToolDefinition | null {
    return this.#tools.get(name) ?? null;
  }

  list(): readonly AnyRegisteredToolDefinition[] {
    return [...this.#tools.values()].sort((left, right) => compareCodePoints(left.name, right.name));
  }

  /** Model-visible schemas are projected from the same Zod facts used by ToolRuntime. */
  listForModel(): readonly ProjectedToolDefinition[] {
    return this.list().filter((tool) => tool.availability.available).map((tool) => {
      const projected = projectSchema(tool.inputSchema, tool.name, "input");
      return {
        name: tool.name,
        description: tool.description,
        parameters: projected,
        strict: false,
      };
    });
  }

  createManifest(generatedAt: UtcTimestamp): ToolCatalogManifest {
    if (this.#manifest) return this.#manifest;
    const entries = this.list().map((tool) => ({
      contract: tool.contract,
      availability: tool.availability,
    }));
    const catalogHash = digest(canonicalJson(entries.map((entry) => ({
      contract: entry.contract,
      available: entry.availability.available,
      reasonCode: entry.availability.reasonCode,
    }))));
    const parsed = toolCatalogManifestSchema.parse({
      schemaVersion: TOOL_CATALOG_SCHEMA_VERSION,
      catalogHash,
      tools: entries,
      generatedAt,
    });
    this.#manifest = Object.freeze({
      ...parsed,
      tools: Object.freeze(parsed.tools.map((entry) => Object.freeze({
        contract: Object.freeze(entry.contract),
        availability: Object.freeze(entry.availability),
      }))),
    });
    return this.#manifest;
  }
}

function registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): RegisteredToolDefinition<TInput, TOutput> {
  if (!toolNameSchema.safeParse(tool.name).success) throw new Error(`Tool name is invalid: ${tool.name}.`);
  if (!versionIdentifierSchema.safeParse(tool.version).success) throw new Error(`Tool ${tool.name} has an invalid version.`);
  if (!versionIdentifierSchema.safeParse(tool.normalizationVersion).success) {
    throw new Error(`Tool ${tool.name} has an invalid normalization version.`);
  }
  if (!tool.description.trim() || tool.description.length > 2_048) {
    throw new Error(`Tool ${tool.name} must have a non-empty description no longer than 2048 characters.`);
  }
  const availability = toolAvailabilitySchema.safeParse(tool.availability);
  if (!availability.success) throw new Error(`Tool ${tool.name} has invalid availability metadata.`);
  assertPolicy(tool);
  const inputSchema = projectSchema(tool.inputSchema, tool.name, "input");
  const outputSchema = projectSchema(tool.outputSchema, tool.name, "output");
  const contract = Object.freeze(toolContractIdentitySchema.parse({
    name: tool.name,
    version: tool.version,
    inputSchemaHash: digest(canonicalJson(inputSchema)),
    outputSchemaHash: digest(canonicalJson(outputSchema)),
    normalizationVersion: tool.normalizationVersion,
  }));
  return Object.freeze({ ...tool, availability: Object.freeze(availability.data), contract });
}

function assertPolicy(tool: AnyToolDefinition): void {
  const valid = tool.risk === "automatic"
    ? tool.sideEffect === "none" && tool.retryPolicy === "safe"
    : tool.risk === "control"
      ? tool.sideEffect === "none" && (tool.retryPolicy === "safe" || tool.retryPolicy === "never")
      : tool.risk === "task_authorized"
        ? tool.sideEffect === "workspace_write" && (tool.retryPolicy === "safe" || tool.retryPolicy === "never")
        : tool.risk === "single_confirmation" && (
          (tool.sideEffect === "workspace_write" && tool.retryPolicy === "never") ||
          (tool.sideEffect === "external_write" && (tool.retryPolicy === "reconcile" || tool.retryPolicy === "never"))
        );
  if (!valid) throw new Error(`Tool ${tool.name} has an invalid risk/side-effect/retry policy combination.`);
}

function projectSchema(schema: z.ZodType, toolName: string, kind: "input" | "output"): JsonObject {
  let rawSchema: unknown;
  try {
    rawSchema = z.toJSONSchema(schema, { target: "draft-7" });
  } catch (error: unknown) {
    throw new Error(`Tool ${toolName} has a ${kind} schema that cannot be projected.`, { cause: error });
  }
  const projected = validateJsonValue(JSON.parse(JSON.stringify(rawSchema)) as unknown);
  if (!projected.ok || projected.value === null || Array.isArray(projected.value) || typeof projected.value !== "object") {
    throw new Error(`Tool ${toolName} has a ${kind} schema that cannot cross the model JSON boundary.`);
  }
  return projected.value as JsonObject;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
