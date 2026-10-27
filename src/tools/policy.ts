import type { ToolDef, ToolResult } from "../types.js";

/**
 * Operator switches enforced at call time (B-016). They never change the tool
 * list or a schema: a blocked tool stays listed and returns isError without
 * sending a request.
 */
export type CallPolicy = {
  /** HETZNER_READ_ONLY: block every tool that is not annotated read-only. */
  readOnly: boolean;
  /** HETZNER_DENY_TOOLS: tool name globs (`*`, `?`) that are always blocked. */
  denyTools: string[];
};

const RAW_REQUEST = "hcloud_raw_request";

/** Whole-name glob match: `*` is any run of characters, `?` one character. */
export function globMatcher(glob: string): (name: string) => boolean {
  const source = glob
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[\\^$.|+()[\]{}]/g, "\\$&")))
    .join("");
  const re = new RegExp(`^${source}$`);
  return (name) => re.test(name);
}

function blocked(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Wraps a tool so the policy is checked before its handler runs. Put it
 * outside the confirm guard, so a blocked tool shows no preview either.
 * hcloud_raw_request is not read-only as a whole; in read-only mode only its
 * GET requests pass.
 */
export function withCallPolicy(tool: ToolDef, policy: CallPolicy): ToolDef {
  const denied = policy.denyTools.some((glob) => globMatcher(glob)(tool.name));
  const isRaw = tool.name === RAW_REQUEST;
  const readOnlyBlocks = policy.readOnly && (isRaw || !tool.annotations.readOnlyHint);
  if (!denied && !readOnlyBlocks) return tool;

  const handler = tool.handler;
  return {
    ...tool,
    handler: async (input, ctx) => {
      if (denied) {
        return blocked(`${tool.name} is disabled by HETZNER_DENY_TOOLS; no request was sent.`);
      }
      if (isRaw && input.method === "GET") return handler(input, ctx);
      const what = isRaw ? `${tool.name} with method ${String(input.method)}` : tool.name;
      return blocked(
        `${what} is not read-only and HETZNER_READ_ONLY=true; no request was sent.`,
      );
    },
  };
}
