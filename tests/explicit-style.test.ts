/**
 * The `explicit` map style: mark tools that need no arguments.
 *
 * On the real 149-tool catalogue, 66 tools (44%) declare no required parameters, so
 * their map line is a bare name — indistinguishable from a tool whose parameters were
 * omitted, which makes the model spend a q() lookup finding out it could just call it.
 * Lookups dominate cost: 0 -> 2 of them was a 6x cost swing.
 *
 * Naming those parameters instead cost 13x more and measured +41% (that style,
 * `optional`, was removed in 0.2.0). The `()` marker states the fact the model lacks
 * for +275 characters.
 *
 * Tier 3, 432 runs, 36 per arm per provider: 144/144 tasks, turns and lookups down on
 * all four providers, median cost -20.7% openai / -15.4% gemini / -9.0% anthropic and
 * +13.2% xai. That split is why it is reached via objective:"cost", not set by hand.
 */
import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  { name: "svc_needs_args", description: "x", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] } },
  { name: "svc_needs_none", description: "y", inputSchema: { type: "object", properties: { limit: { type: "integer" }, offset: { type: "integer" } } } },
  { name: "svc_truly_empty", description: "z", inputSchema: { type: "object", properties: {} } },
];
const mapOf = (p: string) => p.slice(p.indexOf("<toolmap>") + 9, p.indexOf("</toolmap>")).trim();
const c = () => compress(TOOLS, { level: 3, mapStyle: "explicit" });

describe("explicit", () => {
  it("marks a zero-required tool with ()", () => {
    expect(mapOf(c().systemPreamble)).toMatch(/svc_needs_none \(\)/);
  });

  it("marks a tool with no parameters at all the same way — also callable as-is", () => {
    expect(mapOf(c().systemPreamble)).toMatch(/svc_truly_empty \(\)/);
  });

  it("renders a tool with required args byte-identically to the default", () => {
    // 83 of 149 real tools were already informative; this must not touch them.
    const e = mapOf(c().systemPreamble).split("\n").find((l) => l.includes("svc_needs_args"));
    const d = mapOf(compress(TOOLS, { level: 3 }).systemPreamble).split("\n").find((l) => l.includes("svc_needs_args"));
    expect(e).toBe(d);
  });

  it("never claims () for a tool that has required args", () => {
    expect(mapOf(c().systemPreamble)).not.toMatch(/svc_needs_args.*\(\)/);
  });

  it("explains the marker, or the model has to guess what () means", () => {
    expect(c().systemPreamble).toContain("takes no required arguments");
  });

  it("still accepts a zero-required tool called with no arguments", () => {
    const k = c();
    const r = k.resolve("t", { f: k.codeFor("svc_needs_none"), a: {} });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.args).toEqual({});
  });

  it("resolves every tool in the real corpus", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const k = compress(REAL_TOOLS as any, { level: 3, mapStyle: "explicit" });
    const bad = REAL_TOOLS.filter((t: any) => {
      const r = k.resolve("t", { f: k.codeFor(t.name), a: {} });
      return r.kind === "error" && !/Missing required/.test(r.message);
    });
    expect(bad.map((t: any) => t.name)).toEqual([]);
  });

  it("costs only a little more than the default on the real corpus", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const d = mapOf(compress(REAL_TOOLS as any, { level: 3 }).systemPreamble).length;
    const e = mapOf(compress(REAL_TOOLS as any, { level: 3, mapStyle: "explicit" }).systemPreamble).length;
    expect(e).toBeGreaterThan(d);
    expect(e - d).toBeLessThan(d * 0.1); // ~275 chars on a ~5,100-char map
  });
});

describe("the surviving style set is exactly three", () => {
  it("accepts the three measured styles", () => {
    for (const mapStyle of ["name+required", "explicit", "signature"] as const) {
      expect(compress(TOOLS, { level: 3, mapStyle }).stats.mapStyle).toBe(mapStyle);
    }
  });

  it("rejects the styles removed in 0.2.0, rather than silently ignoring them", () => {
    // Each was measured worse: name failed on grok-4.5, terse dropped the real name,
    // nocode had a 19% silent failure rate, grouped/compact/optional cost more.
    for (const gone of ["name", "terse", "nocode", "grouped", "compact", "optional"]) {
      expect(() => compress(TOOLS, { level: 3, mapStyle: gone as any }), gone).toThrow(
        /unsupported mapStyle/,
      );
    }
  });

  it("lists the surviving styles in the error, so the fix is obvious", () => {
    try {
      compress(TOOLS, { level: 3, mapStyle: "nocode" as any });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("name+required");
      expect(e.message).toContain("explicit");
      expect(e.message).toContain("signature");
    }
  });
});
