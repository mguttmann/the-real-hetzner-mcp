import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SPEC_URL = "https://docs.hetzner.cloud/cloud.spec.json";
const OUTPUT = resolve(process.cwd(), "specs/cloud.spec.json");

async function main(): Promise<void> {
  process.stderr.write(`Fetching ${SPEC_URL}\n`);
  const res = await fetch(SPEC_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch spec: HTTP ${res.status}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Spec is not valid JSON: ${(err as Error).message}`);
  }
  const formatted = JSON.stringify(parsed, null, 2) + "\n";

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, formatted, "utf8");

  const sizeKb = (Buffer.byteLength(formatted) / 1024).toFixed(0);
  const info = parsed as { info?: { version?: string; title?: string } };
  process.stderr.write(
    `Wrote ${OUTPUT} (${sizeKb} KB, title="${info.info?.title ?? "?"}", version="${info.info?.version ?? "?"}")\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`refresh-spec failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
