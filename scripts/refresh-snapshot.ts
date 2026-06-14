import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { OPERATIONS } from "../src/tools/generated/operations.js";

const SNAPSHOT_PATH = resolve(process.cwd(), "tests/snapshots/tool-registry.json");

function hashSchema(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  const snapshot = OPERATIONS.map((op) => ({
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
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  process.stderr.write(
    `Wrote ${SNAPSHOT_PATH} with ${snapshot.length} entries.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`refresh-snapshot failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
