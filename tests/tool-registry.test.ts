import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  TOOL_CATALOG_SCHEMA_VERSION,
  ToolRegistry,
  toolCatalogManifestSchema,
} from "../src/tools/tool-registry.js";
import type { ToolAvailability, ToolDefinition } from "../src/tools/tool.js";

const NOW = "2026-08-23T00:00:00.000Z" as const;

describe("ToolRegistry contract catalog", () => {
  it("projects only the runtime input schema and retains input/output contract hashes", () => {
    const registry = new ToolRegistry();
    registry.register(tool("read_file"));

    expect(registry.listForModel()).toEqual([{
      name: "read_file",
      description: "Read a file",
      strict: false,
      parameters: expect.objectContaining({
        type: "object",
        required: ["path"],
        additionalProperties: false,
      }),
    }]);
    expect(registry.get("read_file")?.contract).toMatchObject({
      name: "read_file",
      version: "tool:read_file@1.0.0",
      normalizationVersion: "normalization:test-v1",
      inputSchemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      outputSchemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it("creates a stable sorted catalog independent of registration order and observation time", () => {
    const first = new ToolRegistry();
    first.register(tool("search_text"));
    first.register(tool("read_file"));
    const second = new ToolRegistry();
    second.register(tool("read_file", { checkedAt: "2026-08-23T00:00:01.000Z" }));
    second.register(tool("search_text", { checkedAt: "2026-08-23T00:00:02.000Z" }));

    const firstManifest = first.createManifest(NOW);
    const secondManifest = second.createManifest("2026-08-23T01:00:00.000Z");

    expect(firstManifest.schemaVersion).toBe(TOOL_CATALOG_SCHEMA_VERSION);
    expect(firstManifest.catalogHash).toBe(secondManifest.catalogHash);
    expect(firstManifest.tools.map((entry) => entry.contract.name)).toEqual(["read_file", "search_text"]);
    expect(toolCatalogManifestSchema.parse(firstManifest)).toEqual(firstManifest);
  });

  it("seals the startup catalog after manifest creation", () => {
    const registry = new ToolRegistry();
    registry.register(tool("read_file"));

    const manifest = registry.createManifest(NOW);

    expect(registry.createManifest("2026-08-23T00:00:01.000Z")).toBe(manifest);
    expect(() => registry.register(tool("search_text"))).toThrow("sealed");
  });

  it("changes the catalog identity when a schema, tool version, normalization, or availability changes", () => {
    const hashes = [
      catalog(tool("read_file")),
      catalog(tool("read_file", { version: "tool:read_file@2.0.0" })),
      catalog(tool("read_file", { normalizationVersion: "normalization:test-v2" })),
      catalog(tool("read_file", { extraOutput: true })),
      catalog(tool("read_file", { available: false })),
    ];

    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("excludes unavailable tools from the model projection while preserving their reason in the manifest", () => {
    const registry = new ToolRegistry();
    registry.register(tool("read_file", { available: false }));

    expect(registry.listForModel()).toEqual([]);
    expect(registry.createManifest(NOW).tools[0]?.availability).toMatchObject({
      available: false,
      reasonCode: "runtime_missing",
      message: "Required runtime is unavailable.",
    });
  });

  it.each([
    ["automatic", "workspace_write", "safe"],
    ["task_authorized", "none", "never"],
    ["single_confirmation", "external_write", "safe"],
    ["control", "external_write", "never"],
  ] as const)("rejects invalid policy combination %s/%s/%s", (risk, sideEffect, retryPolicy) => {
    const registry = new ToolRegistry();
    expect(() => registry.register(tool("unsafe_tool", { risk, sideEffect, retryPolicy })))
      .toThrow("invalid risk/side-effect/retry policy");
  });

  it.each([
    ["automatic", "none", "safe"],
    ["task_authorized", "workspace_write", "safe"],
    ["task_authorized", "workspace_write", "never"],
    ["single_confirmation", "workspace_write", "never"],
    ["single_confirmation", "external_write", "reconcile"],
    ["single_confirmation", "external_write", "never"],
    ["control", "none", "safe"],
    ["control", "none", "never"],
  ] as const)("accepts documented policy combination %s/%s/%s", (risk, sideEffect, retryPolicy) => {
    expect(() => new ToolRegistry().register(tool("valid_tool", { risk, sideEffect, retryPolicy })))
      .not.toThrow();
  });

  it("rejects duplicate names and incomplete availability evidence", () => {
    const registry = new ToolRegistry();
    registry.register(tool("read_file"));
    expect(() => registry.register(tool("read_file"))).toThrow("already registered");
    expect(() => new ToolRegistry().register(tool("search_text", {
      availability: { available: false, reasonCode: null, message: null, checkedAt: NOW },
    }))).toThrow("invalid availability");
  });
});

interface ToolOptions {
  readonly version?: string;
  readonly normalizationVersion?: string;
  readonly checkedAt?: typeof NOW | "2026-08-23T00:00:01.000Z" | "2026-08-23T00:00:02.000Z";
  readonly available?: boolean;
  readonly availability?: ToolAvailability;
  readonly extraOutput?: boolean;
  readonly risk?: ToolDefinition["risk"];
  readonly sideEffect?: ToolDefinition["sideEffect"];
  readonly retryPolicy?: ToolDefinition["retryPolicy"];
}

function tool(name: string, options: ToolOptions = {}): ToolDefinition<
  { path: string; startLine?: number | undefined },
  { ok: boolean; detail?: string | undefined }
> {
  const available = options.available ?? true;
  return {
    name,
    version: options.version ?? `tool:${name}@1.0.0`,
    normalizationVersion: options.normalizationVersion ?? "normalization:test-v1",
    description: name === "read_file" ? "Read a file" : `Execute ${name}`,
    risk: options.risk ?? "automatic",
    sideEffect: options.sideEffect ?? "none",
    retryPolicy: options.retryPolicy ?? "safe",
    inputSchema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
    }).strict(),
    outputSchema: options.extraOutput
      ? z.object({ ok: z.boolean(), detail: z.string().optional() }).strict()
      : z.object({ ok: z.boolean() }).strict(),
    availability: options.availability ?? {
      available,
      reasonCode: available ? null : "runtime_missing",
      message: available ? null : "Required runtime is unavailable.",
      checkedAt: options.checkedAt ?? NOW,
    },
    normalizeInput: (input) => ({ effectiveInput: input, transformations: [] }),
    claimResources: (input) => [{ key: `path:${input.path}`, mode: "read", scope: "path" }],
    execute: async () => options.extraOutput ? { ok: true, detail: "extra" } : { ok: true },
  };
}

function catalog(definition: ReturnType<typeof tool>): string {
  const registry = new ToolRegistry();
  registry.register(definition);
  return registry.createManifest(NOW).catalogHash;
}
