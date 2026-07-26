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

describe("savedPct is a character saving, and says so", () => {
  /**
   * 0.2.7 tried to make this a token estimate by dividing each side by a calibrated
   * chars-per-token ratio. Measurement killed it: providers charge a fixed framing cost
   * per tool definition that character counting cannot see, so the ratio approach was off
   * by 44% on a 2-tool level-1 block while being within 1% at 149 tools. No local
   * character-based calculation spans that range.
   *
   * The plain character ratio is the smaller, more predictable error — a few points
   * optimistic — so it is reported as what it is. These tests pin the KNOWN BIAS rather
   * than pretending to token accuracy.
   */
  it("is computed from the character counts it reports", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    for (const level of [1, 2, 3] as const) {
      const s = compress(REAL_TOOLS as any, { level }).stats;
      const fromChars = Math.round((1 - s.compressedChars / s.originalChars) * 1000) / 10;
      expect(s.savedPct, `level ${level}`).toBe(fromChars);
    }
  });

  it("runs optimistic against real token counts, by a few points", async () => {
    // Ground truth from count_tokens on claude-opus-5 over the 149-tool corpus:
    // level 1 is -39.2% and level 3 is -95.6% in tokens. The character figure should sit
    // above both, and not wildly.
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const l1 = compress(REAL_TOOLS as any, { level: 1 }).stats.savedPct;
    const l3 = compress(REAL_TOOLS as any, { level: 3 }).stats.savedPct;
    expect(l1).toBeGreaterThan(39.2);
    expect(l1 - 39.2).toBeLessThan(10);
    expect(l3).toBeGreaterThan(95.6);
    expect(l3 - 95.6).toBeLessThan(3);
  });

  it("never claims a saving when the output grew", () => {
    // Level 1 can enlarge a tiny tool set: the signature line it adds can exceed the
    // per-property descriptions it strips. A negative number here is correct, not a bug.
    const tiny = [{ name: "a_b", description: "x", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    const s = compress(tiny as any, { level: 1 }).stats;
    if (s.compressedChars > s.originalChars) expect(s.savedPct).toBeLessThan(0);
  });

  it("still reports the raw character counts alongside it", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const s = compress(REAL_TOOLS as any, { level: 3 }).stats;
    expect(s.originalChars).toBeGreaterThan(s.compressedChars);
    expect(s.compressedChars).toBeGreaterThan(0);
  });
});
