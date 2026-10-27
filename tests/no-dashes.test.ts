import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { buildRegistry } from "../src/build-registry.js";
import { buildOperations } from "../scripts/generate.js";

// Em dash and en dash (B-005). Written as escapes so this file has none itself.
const DASH = /[\u2014\u2013]/;

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (/\.(ts|mjs|js|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function registry(confirmWrites: boolean) {
  const offlineFetch = (async () => {
    throw new Error("no network in this test");
  }) as typeof globalThis.fetch;
  return buildRegistry(
    loadConfig({
      HETZNER_API_TOKEN: "dummy",
      HETZNER_API_BASE: "http://127.0.0.1:1",
      HETZNER_CONFIRM_WRITES: String(confirmWrites),
    }),
    { fetch: offlineFetch },
  );
}

describe("no em or en dashes (B-005)", () => {
  it("in src, tests and scripts", async () => {
    const root = resolve(__dirname, "..");
    const hits: string[] = [];
    for (const dir of ["src", "tests", "scripts"]) {
      for (const file of await filesUnder(join(root, dir))) {
        const lines = (await readFile(file, "utf8")).split("\n");
        lines.forEach((line, i) => {
          if (DASH.test(line)) hits.push(`${file.slice(root.length + 1)}:${i + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });

  it("in every tool description and input schema, confirm mode on and off", () => {
    for (const confirm of [false, true]) {
      const hits = registry(confirm)
        .getAll()
        .filter((t) => DASH.test(t.description) || DASH.test(JSON.stringify(t.inputSchema)))
        .map((t) => t.name);
      expect(hits).toEqual([]);
    }
  });

  it("in confirm previews", async () => {
    const reg = registry(true);
    for (const name of ["hcloud_delete_server", "hcloud_raw_request"]) {
      const res = await reg.getByName(name)!.handler({ id: 1, method: "POST", path: "/servers" });
      const text = (res.content[0] as { text: string }).text;
      expect(text, name).toMatch(/PREVIEW/);
      expect(DASH.test(text), name).toBe(false);
    }
  });

  it("the generator replaces dashes from the spec in descriptions", () => {
    const ops = buildOperations({
      paths: {
        "/servers": {
          get: {
            summary: "List \u2014 all",
            description: "A 0\u2013100% scale",
            parameters: [
              { name: "q", in: "query", schema: { type: "string", description: "x \u2014 y" } },
            ],
            responses: {},
          },
        },
      },
    });
    expect(DASH.test(JSON.stringify(ops))).toBe(false);
    expect(ops[0]!.summary).toBe("List - all");
    expect(ops[0]!.description).toBe("A 0-100% scale");
  });
});
