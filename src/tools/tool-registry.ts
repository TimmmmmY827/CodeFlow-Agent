import { z } from "zod";

import { validateJsonValue, type JsonObject } from "../shared/json.js";
import type { AnyToolDefinition, ToolDefinition } from "./tool.js";

export interface ProjectedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: false;
}

export class ToolRegistry {
  readonly #tools = new Map<string, AnyToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): AnyToolDefinition | null {
    return this.#tools.get(name) ?? null;
  }

  list(): readonly AnyToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Model-visible schemas are projected from the same Zod facts used by ToolRuntime. */
  listForModel(): readonly ProjectedToolDefinition[] {
    return this.list().map((tool) => {
      const rawSchema = z.toJSONSchema(tool.inputSchema, { target: "draft-7" });
      const projected = validateJsonValue(JSON.parse(JSON.stringify(rawSchema)) as unknown);
      if (!projected.ok || projected.value === null || Array.isArray(projected.value) || typeof projected.value !== "object") {
        throw new Error(`Tool ${tool.name} has an input schema that cannot cross the model JSON boundary.`);
      }
      return {
        name: tool.name,
        description: tool.description,
        parameters: projected.value as JsonObject,
        strict: false,
      };
    });
  }
}
