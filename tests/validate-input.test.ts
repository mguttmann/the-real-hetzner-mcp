import { describe, it, expect } from "vitest";
import { validateToolInput } from "../src/tools/validate-input.js";
import { buildGeneratedTools } from "../src/tools/generated/tools.js";
import { OPERATIONS } from "../src/tools/generated/operations.js";
import { makeRawRequestTool } from "../src/tools/raw_request.js";
import type { JSONSchema } from "../src/types.js";

const idSchema: JSONSchema = {
  type: "object",
  properties: { id: { type: "integer", minimum: 1, maximum: 9007199254740991 } },
  required: ["id"],
  additionalProperties: false,
};

describe("validateToolInput - supported keywords", () => {
  it("accepts a valid input", () => {
    expect(validateToolInput(idSchema, { id: 42 })).toEqual([]);
  });

  it("rejects a string where an integer is declared", () => {
    const errors = validateToolInput(idSchema, { id: "42" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/`id` must be integer/);
    expect(errors[0]).toContain('"42"');
  });

  it("checks every supported type name", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        o: { type: "object" },
        a: { type: "array" },
        s: { type: "string" },
        n: { type: "number" },
        i: { type: "integer" },
        b: { type: "boolean" },
        z: { type: "null" },
      },
    };
    const valid = { o: {}, a: [], s: "x", n: 1.5, i: 7, b: true, z: null };
    expect(validateToolInput(schema, valid)).toEqual([]);

    // One wrong value per property - each must produce exactly one error.
    const wrong: Record<string, unknown> = {
      o: [],          // arrays are not objects
      a: {},
      s: 1,
      n: NaN,         // not finite
      i: 1.5,
      b: "true",
      z: 0,
    };
    for (const [key, value] of Object.entries(wrong)) {
      expect(validateToolInput(schema, { [key]: value }), key).toHaveLength(1);
    }
  });

  it("rejects unsafe integers above 2^53-1", () => {
    expect(validateToolInput(idSchema, { id: 9007199254740992 })).toHaveLength(1);
  });

  it("supports type unions, including a null member", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        body: { type: ["object", "array", "string", "number", "boolean", "null"] },
      },
    };
    for (const body of [{}, [], "x", 1, true, null]) {
      expect(validateToolInput(schema, { body }), JSON.stringify(body)).toEqual([]);
    }
    // Nothing left that a JSON payload could be, so a union failure needs a
    // narrower schema:
    const narrow: JSONSchema = {
      type: "object",
      properties: { v: { type: ["integer", "null"] } },
    };
    expect(validateToolInput(narrow, { v: 5 })).toEqual([]);
    expect(validateToolInput(narrow, { v: null })).toEqual([]);
    expect(validateToolInput(narrow, { v: "5" })).toHaveLength(1);
  });

  it("enforces enum", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { op: { type: "string", enum: ["poweron", "reboot"] } },
    };
    expect(validateToolInput(schema, { op: "reboot" })).toEqual([]);
    const errors = validateToolInput(schema, { op: "nuke" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/must be one of "poweron", "reboot"/);
  });

  it("enforces minimum and maximum", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { n: { type: "integer", minimum: 1, maximum: 10 } },
    };
    expect(validateToolInput(schema, { n: 1 })).toEqual([]);
    expect(validateToolInput(schema, { n: 10 })).toEqual([]);
    expect(validateToolInput(schema, { n: 0 })[0]).toMatch(/must be >= 1/);
    expect(validateToolInput(schema, { n: 11 })[0]).toMatch(/must be <= 10/);
  });

  it("enforces minLength and maxLength", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { s: { type: "string", minLength: 1, maxLength: 3 } },
    };
    expect(validateToolInput(schema, { s: "ab" })).toEqual([]);
    expect(validateToolInput(schema, { s: "" })[0]).toMatch(/at least 1 character/);
    expect(validateToolInput(schema, { s: "abcd" })[0]).toMatch(/at most 3 character/);
  });

  it("checks flat array item types", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { ssh_keys: { type: "array", items: { type: "integer" } } },
    };
    expect(validateToolInput(schema, { ssh_keys: [1, 2] })).toEqual([]);
    const errors = validateToolInput(schema, { ssh_keys: [1, "2/../x", 3] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/`ssh_keys\[1\]` must be integer/);
  });

  it("accepts a bare scalar where an array of scalars is declared", () => {
    // `sort: "name:asc"` instead of `sort: ["name:asc"]`. Every array-typed
    // parameter in this repo is a query parameter that "may be used multiple
    // times"; the scalar form is what callers have always sent and the client
    // turns it into exactly the same single query parameter.
    const schema: JSONSchema = {
      type: "object",
      properties: {
        sort: { type: "array", items: { type: "string" } },
        id: { type: "array", items: { type: "integer" } },
      },
    };
    expect(validateToolInput(schema, { sort: "name:asc" })).toEqual([]);
    expect(validateToolInput(schema, { sort: ["name:asc"] })).toEqual([]);
    expect(validateToolInput(schema, { id: 42 })).toEqual([]);
    expect(validateToolInput(schema, { id: [42, 43] })).toEqual([]);

    // The element type is still enforced, in both shapes.
    const scalarWrong = validateToolInput(schema, { id: "42" });
    expect(scalarWrong).toHaveLength(1);
    expect(scalarWrong[0]).toMatch(/`id` must be integer or an array of them, got "42"/);
    expect(validateToolInput(schema, { id: [42, "43"] })[0]).toMatch(/`id\[1\]` must be integer/);
    // And a scalar is no way around the type check either.
    expect(validateToolInput(schema, { id: "1/../../ssh_keys" })).toHaveLength(1);
    expect(validateToolInput(schema, { sort: {} })).toHaveLength(1);
  });

  it("checks items.enum and item bounds in both call shapes (B-019)", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        status: { type: "array", items: { type: "string", enum: ["running", "success", "error"] } },
        id: { type: "array", items: { type: "integer", minimum: 1, maximum: 100 } },
      },
    };
    expect(validateToolInput(schema, { status: ["running", "error"] })).toEqual([]);
    expect(validateToolInput(schema, { status: "success" })).toEqual([]);
    expect(validateToolInput(schema, { id: [1, 100] })).toEqual([]);
    expect(validateToolInput(schema, { id: 7 })).toEqual([]);

    const badEnum = validateToolInput(schema, { status: ["running", "done"] });
    expect(badEnum).toHaveLength(1);
    expect(badEnum[0]).toMatch(/`status\[1\]` must be one of "running", "success", "error", got "done"/);
    const scalarEnum = validateToolInput(schema, { status: "done" });
    expect(scalarEnum).toHaveLength(1);
    expect(scalarEnum[0]).toMatch(/`status` must be one of "running", "success", "error", got "done"/);

    expect(validateToolInput(schema, { id: [0] })[0]).toMatch(/`id\[0\]` must be >= 1, got 0/);
    expect(validateToolInput(schema, { id: [101] })[0]).toMatch(/`id\[0\]` must be <= 100, got 101/);
    expect(validateToolInput(schema, { id: 0 })[0]).toMatch(/`id` must be >= 1, got 0/);
    expect(validateToolInput(schema, { id: -5 })).toHaveLength(1);
  });

  it("caps item enum and bound errors like type errors (B-019)", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { status: { type: "array", items: { type: "string", enum: ["running"] } } },
    };
    const errors = validateToolInput(schema, { status: Array(500).fill("x") });
    expect(errors).toHaveLength(11);
    expect(errors[10]).toMatch(/490 further element\(s\)/);
  });

  it("still demands an array when the element type is not a scalar", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        rules: { type: "array", items: { type: "object" } },
        untyped: { type: "array", items: {} },
      },
    };
    expect(validateToolInput(schema, { rules: {} })[0]).toMatch(/`rules` must be array/);
    expect(validateToolInput(schema, { untyped: "x" })[0]).toMatch(/`untyped` must be array/);
  });

  it("skips item checks when items are objects or untyped", () => {
    const objectItems: JSONSchema = {
      type: "object",
      properties: { rules: { type: "array", items: { type: "object" } } },
    };
    expect(validateToolInput(objectItems, { rules: ["not an object"] })).toEqual([]);
    const untypedItems: JSONSchema = {
      type: "object",
      properties: { rules: { type: "array", items: {} } },
    };
    expect(validateToolInput(untypedItems, { rules: [1, "x", null] })).toEqual([]);
  });

  it("reports missing required properties", () => {
    expect(validateToolInput(idSchema, {})).toEqual([
      "missing required property `id`.",
    ]);
  });

  it("treats an explicitly undefined required property as missing", () => {
    expect(validateToolInput(idSchema, { id: undefined })).toEqual([
      "missing required property `id`.",
    ]);
  });

  it("rejects unknown keys when additionalProperties is false", () => {
    const errors = validateToolInput(idSchema, { id: 1, evil: "x" });
    expect(errors).toEqual(["unknown property `evil`."]);
  });

  it("allows unknown keys when additionalProperties is not false", () => {
    const open: JSONSchema = { type: "object", properties: { id: { type: "integer" } } };
    expect(validateToolInput(open, { id: 1, extra: "x" })).toEqual([]);
  });

  it("does not treat inherited object keys as declared properties", () => {
    const errors = validateToolInput(idSchema, { id: 1, toString: "x" });
    expect(errors).toEqual(["unknown property `toString`."]);
  });

  it("always tolerates the out-of-band `confirm` key", () => {
    expect(validateToolInput(idSchema, { id: 1, confirm: "YES" })).toEqual([]);
  });

  it("always tolerates the builder control keys `wait` and `auto_paginate`", () => {
    // splitInput discards both for every generated tool, declared or not, so a
    // client that sends them habitually (they appear in half the published
    // schemas) must not be rejected by a tool that happens not to declare them.
    expect(validateToolInput(idSchema, { id: 1, wait: false })).toEqual([]);
    expect(validateToolInput(idSchema, { id: 1, auto_paginate: false })).toEqual([]);
    expect(
      validateToolInput(idSchema, { id: 1, wait: true, auto_paginate: true, confirm: "YES" }),
    ).toEqual([]);
  });

  it("still rejects `body` where it is not declared - payload, not a control key", () => {
    expect(validateToolInput(idSchema, { id: 1, body: { x: 1 } })).toEqual([
      "unknown property `body`.",
    ]);
  });

  it("collects multiple errors", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 }, op: { type: "string" } },
      required: ["id", "op"],
      additionalProperties: false,
    };
    const errors = validateToolInput(schema, { id: 0, evil: 1 });
    expect(errors).toEqual([
      "missing required property `op`.",
      "`id` must be >= 1, got 0.",
      "unknown property `evil`.",
    ]);
  });
});

describe("validateToolInput - redactValues (log hygiene)", () => {
  const SECRET =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDSUPERSECRETKEYMATERIAL";
  const bodySchema: JSONSchema = {
    type: "object",
    properties: { body: { type: "object" }, id: { type: "integer", minimum: 1 } },
  };

  it("keeps the value out of the message but names its shape", () => {
    const [message] = validateToolInput(bodySchema, { body: SECRET }, { redactValues: true });
    expect(message).toBe(`\`body\` must be object, got string(${SECRET.length} chars).`);
    expect(message).not.toContain("PRIVATE KEY");
    expect(message).not.toContain("SUPERSECRET");
  });

  it("still quotes the value for the caller when not redacting", () => {
    const [message] = validateToolInput(bodySchema, { body: SECRET });
    expect(message).toContain("BEGIN PRIVATE KEY");
  });

  it("redacts every kind of value it can be handed", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        s: { type: "integer" },
        o: { type: "integer" },
        a: { type: "integer" },
        n: { type: "string" },
        z: { type: "string" },
        b: { type: "string" },
        e: { type: "string", enum: ["a"] },
        arr: { type: "array", items: { type: "integer" } },
      },
    };
    const errors = validateToolInput(
      schema,
      {
        s: "hunter2",
        o: { password: "hunter2" },
        a: ["hunter2", "hunter2"],
        n: 4711,
        z: null,
        b: true,
        e: "hunter2",
        arr: [1, "hunter2"],
      },
      { redactValues: true },
    );
    expect(errors).toEqual([
      "`s` must be integer, got string(7 chars).",
      "`o` must be integer, got object(Object).",
      "`a` must be integer, got array(2 items).",
      "`n` must be string, got number.",
      "`z` must be string, got null.",
      "`b` must be string, got boolean.",
      '`e` must be one of "a", got string(7 chars).',
      "`arr[1]` must be integer, got string(7 chars).",
    ]);
    for (const message of errors) expect(message).not.toContain("hunter2");
  });

  it("survives values without a prototype", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.secret = "x";
    const [message] = validateToolInput(bodySchema, { id: bare }, { redactValues: true });
    expect(message).toBe("`id` must be integer, got object(Object).");
  });
});

describe("validateToolInput - deliberately not implemented (fail-open)", () => {
  it("ignores format, pattern, nullable and default", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        when: { type: "string", format: "date-time" },
        path: { type: "string", pattern: "^/.+" },
        maybe: { type: "integer", nullable: true, default: 5 },
      },
    };
    expect(validateToolInput(schema, { when: "not a date", path: "no slash" })).toEqual([]);
    // `nullable` is not honoured, so null still fails the declared type - the
    // point here is only that `nullable` itself is never evaluated.
    expect(validateToolInput(schema, { maybe: 5 })).toEqual([]);
  });

  it("ignores allOf / oneOf / anyOf and unknown type names", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        combined: { allOf: [{ type: "string" }, { minLength: 5 }] },
        weird: { type: "any" },
        multi: { type: ["string", "widget"] },
      },
    };
    expect(validateToolInput(schema, { combined: 1, weird: [], multi: 7 })).toEqual([]);
  });

  it("never recurses into object values", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    };
    expect(
      validateToolInput(schema, { body: { nonsense: [{ deeply: { nested: null } }] } }),
    ).toEqual([]);
  });

  it("passes through schemas without an object `properties` map", () => {
    expect(validateToolInput({ type: "object" }, { anything: 1 })).toEqual([]);
    expect(validateToolInput({}, { anything: 1 })).toEqual([]);
    expect(validateToolInput({ properties: "nope" }, { anything: 1 })).toEqual([]);
    expect(validateToolInput(null as unknown as JSONSchema, { a: 1 })).toEqual([]);
  });

  it("ignores a non-array `required` and non-string members", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { id: { type: "integer" } },
      required: [7, "id"],
    };
    expect(validateToolInput(schema, { id: 1 })).toEqual([]);
  });
});

describe("validateToolInput - no false rejections against the real tool set", () => {
  const tools = buildGeneratedTools({ request: async () => ({}) } as never, OPERATIONS, {
    maxItems: 500,
    maxPages: 10,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));

  function schemaOf(name: string): JSONSchema {
    const tool = byName.get(name);
    if (!tool) throw new Error(`fixture tool missing: ${name}`);
    return tool.inputSchema;
  }

  it("covers the whole generated tool set", () => {
    expect(tools.length).toBeGreaterThan(150);
  });

  it("accepts an integer path id (hcloud_get_server_raw)", () => {
    expect(validateToolInput(schemaOf("hcloud_get_server_raw"), { id: 42 })).toEqual([]);
    expect(
      validateToolInput(schemaOf("hcloud_get_server_raw"), { id: "42" }),
    ).toHaveLength(1);
  });

  it("accepts `wait`/`auto_paginate` on the tools that do not declare them", () => {
    // Regression: enforcing additionalProperties:false rejected these on 90 (wait)
    // and 160 (auto_paginate) of the generated tools, although the handler discards
    // both keys for every one of them.
    const undeclaredWait = tools.filter(
      (t) => !(t.inputSchema.properties as Record<string, unknown>).wait,
    );
    const undeclaredPaginate = tools.filter(
      (t) => !(t.inputSchema.properties as Record<string, unknown>).auto_paginate,
    );
    expect(undeclaredWait.length).toBeGreaterThan(50);
    expect(undeclaredPaginate.length).toBeGreaterThan(50);
    for (const tool of undeclaredWait) {
      expect(
        validateToolInput(tool.inputSchema, { wait: false }).filter((e) =>
          e.includes("unknown property"),
        ),
        tool.name,
      ).toEqual([]);
    }
    for (const tool of undeclaredPaginate) {
      expect(
        validateToolInput(tool.inputSchema, { auto_paginate: false }).filter((e) =>
          e.includes("unknown property"),
        ),
        tool.name,
      ).toEqual([]);
    }
    expect(validateToolInput(schemaOf("hcloud_get_server_raw"), { id: 42, wait: false })).toEqual(
      [],
    );
    expect(validateToolInput(schemaOf("hcloud_list_servers_raw"), { wait: false })).toEqual([]);
  });

  it("accepts a STRING id_or_name - the DNS/zone tools must not break", () => {
    expect(
      validateToolInput(schemaOf("hcloud_delete_zone"), { id_or_name: "example.com" }),
    ).toEqual([]);
    expect(validateToolInput(schemaOf("hcloud_delete_zone"), { id_or_name: "42" })).toEqual([]);
  });

  it("accepts string rr_name plus enum rr_type", () => {
    expect(
      validateToolInput(schemaOf("hcloud_delete_zone_rrset"), {
        id_or_name: "example.com",
        rr_name: "www",
        rr_type: "A",
      }),
    ).toEqual([]);
    expect(
      validateToolInput(schemaOf("hcloud_delete_zone_rrset"), {
        id_or_name: "example.com",
        rr_name: "www",
        rr_type: "NOPE",
      }),
    ).toHaveLength(1);
  });

  it("accepts a deeply nested request body (hcloud_create_server)", () => {
    expect(
      validateToolInput(schemaOf("hcloud_create_server"), {
        body: {
          name: "web-1",
          server_type: "cpx11",
          image: "ubuntu-24.04",
          public_net: { enable_ipv4: true, enable_ipv6: false },
          labels: { env: "prod" },
          firewalls: [{ firewall: 1 }],
        },
      }),
    ).toEqual([]);
  });

  it("accepts BOTH call shapes for every array-typed parameter in the tool set", () => {
    // The empty-arguments loop below can only ever produce `required` errors, so
    // it cannot see a type check that rejects a call shape that used to work.
    // This one feeds every array-typed property a real value in both shapes.
    const sample: Record<string, unknown> = {
      string: "name:asc",
      integer: 42,
      number: 1.5,
      boolean: true,
    };
    let checked = 0;
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, JSONSchema> })
        .properties;
      if (!properties) continue;
      for (const [key, propSchema] of Object.entries(properties)) {
        if (propSchema.type !== "array") continue;
        const itemType = (propSchema.items as { type?: string } | undefined)?.type;
        const enumValues = (propSchema.items as { enum?: unknown[] } | undefined)?.enum;
        const value = Array.isArray(enumValues) ? enumValues[0] : sample[itemType ?? ""];
        expect(value, `${tool.name}.${key}: no sample for items.type ${String(itemType)}`).not.toBe(
          undefined,
        );
        // Other required properties are missing in this minimal call; the only
        // thing under test is that nothing is reported about `key` itself.
        const about = (input: Record<string, unknown>) =>
          validateToolInput(tool.inputSchema, input).filter((e) => e.includes(`\`${key}`));
        expect(about({ [key]: value }), `${tool.name}.${key} = scalar`).toEqual([]);
        expect(about({ [key]: [value] }), `${tool.name}.${key} = [scalar]`).toEqual([]);
        checked++;
      }
    }
    // sort (35x), status (23x), id (11x), type (6x), bound_to (1x)
    expect(checked).toBeGreaterThan(70);
  });

  it("accepts realistic input for every generated tool's optional-only call shape", () => {
    // A call with no arguments must only ever fail on `required`, never on a
    // keyword we misinterpret.
    for (const tool of tools) {
      const errors = validateToolInput(tool.inputSchema, {});
      for (const err of errors) {
        expect(err, `${tool.name}: ${err}`).toMatch(/^missing required property/);
      }
    }
  });

  it("accepts the raw_request contract, including a string body and confirm", () => {
    const schema = makeRawRequestTool({
      client: { request: async () => ({}) } as never,
      confirmWrites: false,
    }).inputSchema;
    expect(validateToolInput(schema, { method: "GET", path: "/servers" })).toEqual([]);
    expect(
      validateToolInput(schema, { method: "POST", path: "/x", body: "plain string" }),
    ).toEqual([]);
    expect(validateToolInput(schema, { method: "POST", path: "/x", body: null })).toEqual([]);
    expect(
      validateToolInput(schema, { method: "POST", path: "/x", confirm: "YES" }),
    ).toEqual([]);
    // `pattern` is not evaluated - raw_request keeps its own startsWith("/") check.
    expect(validateToolInput(schema, { method: "GET", path: "no-slash" })).toEqual([]);
    expect(validateToolInput(schema, { method: "OPTIONS", path: "/x" })).toHaveLength(1);
  });
});

describe("per-element error cap (refs #54 QA)", () => {
  const schema = {
    type: "object",
    properties: { sort: { type: "array", items: { type: "string" } } },
  } as never;

  it("caps a large bad array at the first 10 messages plus a count", () => {
    const errors = validateToolInput(schema, { sort: Array(5000).fill(1) });
    // 10 element messages + 1 summary - not 5000. A caller learns nothing from
    // the 500th identical type error, and the log is a shared resource.
    expect(errors).toHaveLength(11);
    expect(errors[10]).toMatch(/4990 further element\(s\)/);
  });

  it("bounds the total message size regardless of input size", () => {
    const errors = validateToolInput(schema, { sort: Array(200_000).fill(1) });
    expect(errors.join("").length).toBeLessThan(2_000);
  });

  it("still reports every element when there are only a few", () => {
    const errors = validateToolInput(schema, { sort: [1, 2, "ok"] });
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => /further element/.test(e))).toBe(false);
  });
});
