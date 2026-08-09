import type { ToolDefinition } from "./tool.js";

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | null {
    return this.#tools.get(name) ?? null;
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }
}
