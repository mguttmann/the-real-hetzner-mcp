import type { ToolDef, ToolResult } from "../types.js";

function shouldGuard(tool: ToolDef, enabled: boolean): boolean {
  if (!enabled) return false;
  return tool.annotations.destructiveHint || !tool.annotations.readOnlyHint;
}

function previewResult(tool: ToolDef, input: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `PREVIEW — would execute ${tool.name}\n` +
          `Input: ${JSON.stringify(input, null, 2)}\n` +
          `To execute, retry the same call with confirm: "YES".`,
      },
    ],
  };
}

export function withConfirmGuard(tool: ToolDef, enabled: boolean): ToolDef {
  if (!shouldGuard(tool, enabled)) return tool;

  const props = {
    ...(tool.inputSchema as { properties?: Record<string, unknown> }).properties,
    confirm: {
      type: "string",
      enum: ["YES"],
      description:
        'Set to "YES" to actually execute. Without this, the tool returns a preview only.',
    },
  };
  const inputSchema = {
    ...tool.inputSchema,
    properties: props,
  };

  const originalHandler = tool.handler;
  return {
    ...tool,
    inputSchema,
    handler: async (input) => {
      if (input.confirm !== "YES") {
        return previewResult(tool, input);
      }
      const { confirm: _drop, ...rest } = input;
      return originalHandler(rest);
    },
  };
}
