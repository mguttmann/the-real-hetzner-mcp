import type { ToolDef } from "../../types.js";
import type { HetznerHttpClient, HttpMethod, HttpResponse } from "../../http/client.js";
import { fetchAllPages } from "../../http/pagination.js";

type RequestFn = <T = unknown>(
  method: HttpMethod,
  path: string,
  options?: { query?: Record<string, unknown> },
) => Promise<HttpResponse<T>>;

type Server = { id: number; name: string; [k: string]: unknown };

export function makeServerListTool(
  client: HetznerHttpClient,
  limits: { maxItems: number; maxPages: number },
): ToolDef {
  return {
    name: "hcloud_list_servers",
    description:
      "List Hetzner Cloud servers. Hand-tuned wrapper around GET /servers with an optional client-side name_contains filter and a default sort of 'name'. Use hcloud_list_servers_raw for the unfiltered, generator-built tool.",
    inputSchema: {
      type: "object",
      properties: {
        name_contains: {
          type: "string",
          description: "Case-insensitive substring filter applied after fetching.",
        },
        label_selector: {
          type: "string",
          description: "Hetzner label selector, forwarded as query parameter.",
        },
        sort: {
          type: "string",
          enum: [
            "id", "id:asc", "id:desc",
            "name", "name:asc", "name:desc",
            "created", "created:asc", "created:desc",
          ],
          default: "name",
        },
        page: { type: "integer", minimum: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    handler: async (input) => {
      const query: Record<string, unknown> = {
        sort: typeof input.sort === "string" ? input.sort : "name",
      };
      if (typeof input.label_selector === "string") {
        query.label_selector = input.label_selector;
      }
      if (typeof input.page === "number") query.page = input.page;
      if (typeof input.per_page === "number") query.per_page = input.per_page;

      const request = client.request.bind(client) as unknown as RequestFn;
      const page = await fetchAllPages<Server>(
        request,
        "GET",
        "/servers",
        query,
        { resourceKey: "servers", maxItems: limits.maxItems, maxPages: limits.maxPages },
      );

      let servers = page.items;
      if (typeof input.name_contains === "string" && input.name_contains.length > 0) {
        const needle = input.name_contains.toLowerCase();
        servers = servers.filter((s) => s.name.toLowerCase().includes(needle));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                servers,
                truncated: page.truncated,
                pagination: page.pagination ?? null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
