import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { OPERATIONS } from "../src/tools/generated/operations.js";

type Snapshot = Array<{ name: string; schemaHash: string }>;

const SNAPSHOT_PATH = resolve(process.cwd(), "tests/snapshots/tool-registry.json");

function hashSchema(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

describe("codegen snapshot", () => {
  it("matches the committed snapshot of generated tool names + schemas", async () => {
    const current: Snapshot = OPERATIONS.map((op) => ({
      name: op.toolName,
      schemaHash: hashSchema({
        parameters: op.parameters,
        requestBodySchema: op.requestBodySchema ?? null,
        requestBodyRequired: op.requestBodyRequired ?? false,
        returnsAction: op.returnsAction,
        method: op.method,
        path: op.path,
      }),
    }));
    const committedRaw = await readFile(SNAPSHOT_PATH, "utf8");
    const committed: Snapshot = JSON.parse(committedRaw);
    expect(current).toEqual(committed);
  });
});
