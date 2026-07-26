/**
 * The public API contract, and how it behaves when misused.
 *
 * This library is consumed as a package, so `dist/` is the product — not `src/`. These
 * tests pin the surface and the failure modes, because a library that throws a useful
 * error is usable and one that returns quiet nonsense is not. Every silent-failure
 * mode this project shipped and later fixed is represented here.
 */
import { describe, it, expect } from "vitest";
import {
  compress,
  recommendLevel,
  selectMapStyle,
  POLICY,
  CONSERVATIVE_DEFAULT,
  forAnthropic,
  forOpenAI,
  forOpenAIResponses,
  forGemini,
} from "../src/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  { name: "svc_do_thing", description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
];

describe("the exported surface is what we intend to support", () => {
  it("exports the functions the docs use", () => {
    for (const fn of [compress, recommendLevel, selectMapStyle, forAnthropic, forOpenAI, forOpenAIResponses, forGemini]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("exports the policy so callers can see why a style was chosen", () => {
    // dist/ is what ships; src/policy.generated.ts is not in the tarball, so without
    // these exports the README would point at a file consumers cannot open.
    expect(Array.isArray(POLICY)).toBe(true);
    expect(CONSERVATIVE_DEFAULT).toBe("name+required");
  });
});

describe("bad input fails loudly", () => {
  it("rejects an unsupported level", () => {
    expect(() => compress(TOOLS, { level: 9 as any })).toThrow(/unsupported level/);
  });

  it("rejects an unsupported mapStyle rather than ignoring it", () => {
    expect(() => compress(TOOLS, { level: 3, mapStyle: "nope" as any })).toThrow(/unsupported mapStyle/);
  });

  it("rejects a tool with no name", () => {
    expect(() => compress([{ description: "d" } as any])).toThrow(/missing a name/);
  });

  it("rejects duplicate tool names, which would collide in the map", () => {
    expect(() => compress([TOOLS[0], TOOLS[0]])).toThrow(/duplicate tool name/);
  });

  it("rejects a namespaceOf that returns the wrong shape", () => {
    expect(() => compress(TOOLS, { level: 2, namespaceOf: (() => "x") as any })).toThrow(
      /must return \{ ns, op \}/,
    );
  });

  it("survives a tool with no schema at all", () => {
    const c = compress([{ name: "bare_tool", description: "d" }], { level: 3 });
    expect(c.tools.length).toBeGreaterThan(0);
    const r = c.resolve("t", { f: c.codeFor("bare_tool"), a: {} });
    expect(r.kind).toBe("call");
  });

  it("survives an empty tool list without throwing", () => {
    for (const level of [0, 1, 2, 3] as const) {
      expect(() => compress([], { level }), `level ${level}`).not.toThrow();
    }
  });

  it("accepts both inputSchema and input_schema", () => {
    const a = compress([{ name: "x_y", description: "d", inputSchema: { type: "object", properties: { q: { type: "string" } } } }], { level: 1 });
    const b = compress([{ name: "x_y", description: "d", input_schema: { type: "object", properties: { q: { type: "string" } } } }] as any, { level: 1 });
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
  });
});

describe("resolve never returns quiet nonsense", () => {
  it("returns an error, not a throw, for an unknown tool", () => {
    const r = compress(TOOLS, { level: 3 }).resolve("t", { f: "not_a_tool", a: {} });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message.length).toBeGreaterThan(10);
  });

  it("names the offending parameter when arguments are wrong", () => {
    const c = compress(TOOLS, { level: 3 });
    const r = c.resolve("t", { f: c.codeFor("svc_do_thing"), a: { wrong: 1 } });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/a\b/);
  });

  it("codeFor throws rather than returning undefined below level 3", () => {
    expect(() => compress(TOOLS, { level: 1 }).codeFor("svc_do_thing")).toThrow();
  });
});

describe("every level round-trips the whole real corpus", () => {
  it("resolves all 149 real tools back to their real names", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    for (const level of [0, 1, 2, 3] as const) {
      const c = compress(REAL_TOOLS as any, { level });
      const bad = REAL_TOOLS.filter((t: any) => {
        const raw = c.encodeCallForTest(t.name, {});
        const r = c.resolve(raw.name, raw.args);
        return r.kind === "error" && !/Missing required/.test(r.message);
      });
      expect(bad.map((t: any) => t.name), `level ${level}`).toEqual([]);
    }
  });

  it("produces byte-identical output across repeated calls, at every level", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    for (const level of [0, 1, 2, 3] as const) {
      const runs = [1, 2, 3].map(() => {
        const c = compress(REAL_TOOLS as any, { level });
        return JSON.stringify(c.tools) + c.systemPreamble;
      });
      expect(new Set(runs).size, `level ${level}`).toBe(1);
    }
  });
});

describe("savedPct estimates tokens, not characters", () => {
  /**
   * It used to be a raw character ratio and overstated by 7.6 points at level 1 — 46.8%
   * reported against 39.2% measured by count_tokens. The field was documented as "do not
   * publish this" instead of being fixed.
   *
   * Characters per token is not constant across the two sides: uncompressed JSON is
   * punctuation-dense, a signature line or map row reads more like prose. Each side is now
   * divided by a ratio calibrated against count_tokens on two unrelated corpora.
   *
   * Ground truth below is from count_tokens on claude-opus-5 over the committed 149-tool
   * corpus, so this test fails if the calibration drifts.
   */
  const MEASURED: Record<number, number> = { 1: 39.2, 2: 88.4, 3: 95.6 };

  for (const level of [1, 2, 3] as const) {
    it(`level ${level} is within 2pp of the measured token saving`, async () => {
      const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
      const { savedPct } = compress(REAL_TOOLS as any, { level }).stats;
      expect(Math.abs(savedPct - MEASURED[level]), `savedPct=${savedPct}`).toBeLessThan(2);
    });
  }

  it("would have failed on the old character-ratio implementation", async () => {
    // The old value at level 1 was 46.8%, which is 7.6pp out — outside the 2pp bound
    // above. Recorded so the bound is understood as load-bearing, not arbitrary.
    expect(Math.abs(46.8 - MEASURED[1])).toBeGreaterThan(2);
  });

  it("still reports the raw character counts alongside it", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const s = compress(REAL_TOOLS as any, { level: 3 }).stats;
    expect(s.originalChars).toBeGreaterThan(s.compressedChars);
    expect(s.compressedChars).toBeGreaterThan(0);
  });
});
