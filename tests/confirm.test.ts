import { describe, it, expect, vi } from "vitest";
import { withConfirmGuard } from "../src/tools/confirm.js";
import type { ToolDef } from "../src/types.js";

const destructiveTool: ToolDef = {
  name: "hcloud_delete_server",
  description: "delete",
  inputSchema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: vi.fn(async (input) => ({
    content: [{ type: "text", text: `deleted ${input.id}` }],
  })),
};

const readOnlyTool: ToolDef = {
  name: "hcloud_list_servers",
  description: "list",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
};

describe("withConfirmGuard", () => {
  it("is a no-op when enabled=false", async () => {
    const guarded = withConfirmGuard(destructiveTool, false);
    const res = await guarded.handler({ id: 42 });
    expect((res.content[0] as { text: string }).text).toBe("deleted 42");
  });

  it("blocks destructive calls without confirm:YES when enabled=true", async () => {
    const guarded = withConfirmGuard(destructiveTool, true);
    const res = await guarded.handler({ id: 42 });
    expect((res.content[0] as { text: string }).text).toMatch(/PREVIEW/i);
    expect(res.isError).toBeFalsy();
  });

  it("passes through destructive calls with confirm:YES", async () => {
    const handler = vi.fn(async (input: any) => ({ content: [{ type: "text", text: `ok ${input.id}` }] }));
    const tool = { ...destructiveTool, handler };
    const guarded = withConfirmGuard(tool, true);
    const res = await guarded.handler({ id: 42, confirm: "YES" });
    expect((res.content[0] as { text: string }).text).toBe("ok 42");
    expect(handler).toHaveBeenCalledWith({ id: 42 }); // confirm stripped before forwarding
  });

  it("never guards read-only tools, even when enabled=true", async () => {
    const guarded = withConfirmGuard(readOnlyTool, true);
    const res = await guarded.handler({});
    expect((res.content[0] as { text: string }).text).toBe("[]");
  });

  it("adds 'confirm' to inputSchema only when guarded", () => {
    const guardedReadOnly = withConfirmGuard(readOnlyTool, true);
    expect((guardedReadOnly.inputSchema as any).properties.confirm).toBeUndefined();

    const guardedDestructive = withConfirmGuard(destructiveTool, true);
    expect((guardedDestructive.inputSchema as any).properties.confirm).toBeDefined();
  });
});
