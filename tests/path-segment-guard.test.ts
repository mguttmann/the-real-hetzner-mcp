// Unit tests for the shared single-segment guard behind the string-typed path
// parameters (`id_or_name`, `rr_name`). The end-to-end proof that no request
// leaves the process lives in tests/adversarial-path-injection.test.ts; this file
// pins the predicate itself, in both directions.
import { describe, it, expect } from "vitest";
import { pathSegmentIssue, invalidPathValueResult } from "../src/tools/_validate.js";

describe("pathSegmentIssue - values that must not fill a path slot", () => {
  it("rejects a raw separator in either direction", () => {
    // encodeURIComponent turns these into %2F/%5C, which the Hetzner API decodes
    // before routing when a ".." dot segment is present - the escalation from #54.
    for (const value of [
      "../servers/42",
      "../ssh_keys",
      "../../ssh_keys",
      "servers/42",
      "42/actions/reset_password",
      "1/../../floating_ips/9/actions/unassign",
      "..\\servers",
      "\\evil.com",
      "//evil.com/x",
      "http://evil.com",
    ]) {
      expect(pathSegmentIssue(value), value).toBe('must not contain "/" or "\\"');
    }
  });

  it("rejects a percent-encoded separator or dot in any casing", () => {
    for (const value of [
      "..%2Fssh_keys",
      "..%2fssh_keys",
      "%2e%2e",
      "%2E%2E",
      ".%2e",
      "%5c..",
      "%5C..",
      "..%2f..%2f",
    ]) {
      expect(pathSegmentIssue(value), value).toBe(
        "must not contain a percent-encoded separator (%2f, %5c, %2e)",
      );
    }
  });

  it("rejects the segment-deleting values", () => {
    expect(pathSegmentIssue("")).toBe("must not be empty");
    expect(pathSegmentIssue(".")).toBe('must not be "." or ".."');
    expect(pathSegmentIssue("..")).toBe('must not be "." or ".."');
  });
});

describe("pathSegmentIssue - values that must keep working", () => {
  it("accepts every legitimate zone name and record label", () => {
    for (const value of [
      "example.com",
      "münchen.de",
      "xn--mnchen-3ya.de",
      "example.com.", // fully qualified
      "EXAMPLE.COM",
      "a'b.example.com",
      "zone(1).example.com",
      "sub.domain.example.com",
      "@", // apex
      "*",
      "*.sub",
      "_dmarc",
      "_acme-challenge",
      "A",
      "TXT",
      "42", // numeric ids arrive as String(v)
      "9007199254740991",
      "a".repeat(253),
      "%252e%252e", // double-encoded: no separator is spelled
      "1@evil.com", // userinfo confusion is a URL-level concern, not a separator
      "a;b",
      "a,b",
      "a b", // encoded to %20, stays one segment
      "a#b",
      "a?b",
    ]) {
      expect(pathSegmentIssue(value), value).toBeNull();
    }
  });
});

describe("invalidPathValueResult", () => {
  it("names the field, quotes the value and caps its length", () => {
    const res = invalidPathValueResult("id_or_name", "../servers/42", 'must not contain "/"');
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("`id_or_name`");
    expect(text).toContain('"../servers/42"');
    const long = invalidPathValueResult("rr_name", "x".repeat(5000), "nope");
    expect((long.content[0] as { text: string }).text.length).toBeLessThan(200);
  });
});
