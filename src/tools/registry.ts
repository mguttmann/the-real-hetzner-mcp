import type { ToolDef } from "../types.js";

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    if (this.byName.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.byName.set(tool.name, tool);
  }

  getAll(): ToolDef[] {
    return Array.from(this.byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  getByName(name: string): ToolDef | undefined {
    return this.byName.get(name);
  }

  size(): number {
    return this.byName.size;
  }
}
