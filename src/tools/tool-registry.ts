import type { AnyToolDefinition, ToolDefinition } from "./tool.js";

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
}
