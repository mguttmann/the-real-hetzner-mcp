import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../src/server.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createLogger } from "../src/logger.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("server version", () => {
  it("reports the package.json version in initialize", async () => {
    const server = createMcpServer(new ToolRegistry(), createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientTransport);
    expect(client.getServerVersion()).toEqual({
      name: "the-real-hetzner-mcp",
      version: pkg.version,
    });
    await client.close();
    await server.close();
  });

  it("reads the version from a package.json next to or above the module", async () => {
    const { readPackageVersion } = await import("../src/version.js");
    expect(readPackageVersion(new URL("../src/index.ts", import.meta.url).href)).toBe(
      pkg.version,
    );
    expect(readPackageVersion("file:///nonexistent/dir/index.js")).toBe("0.0.0-unknown");
  });

  it("takes serverInfo.version from version.ts, not from a literal", async () => {
    vi.resetModules();
    vi.doMock("../src/version.js", () => ({ SERVER_VERSION: "9.9.9-test" }));
    try {
      const { createMcpServer: create } = await import("../src/server.js");
      const server = create(new ToolRegistry(), createLogger("error"));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(clientTransport);
      expect(client.getServerVersion()?.version).toBe("9.9.9-test");
      await client.close();
      await server.close();
    } finally {
      vi.doUnmock("../src/version.js");
      vi.resetModules();
    }
  });
});
