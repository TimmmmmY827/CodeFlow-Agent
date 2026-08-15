import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("ToolRegistry model projection", () => {
  it("projects the runtime Zod schema as strict JSON Schema", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "Read a file",
      risk: "automatic",
      sideEffect: "none",
      retryPolicy: "safe",
      inputSchema: z.object({ path: z.string().min(1), startLine: z.number().int().positive().optional() }).strict(),
      execute: async () => ({ ok: true }),
    });

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
  });
});
