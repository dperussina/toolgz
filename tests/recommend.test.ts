import { describe, it, expect } from "vitest";
import { recommendLevel, compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const mk = (ns: string, op: string): Tool => ({
  name: `${ns}_${op}`,
  description: `Perform ${op} against ${ns}. Verbose on purpose so there is something to compress.`,
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "string", description: "param a described at length" },
      b: { type: "string", description: "param b described at length" },
    },
    required: ["a"],
  },
});

const build = (namespaces: number, opsEach: number): Tool[] =>
  Array.from({ length: namespaces * opsEach }, (_, i) =>
    mk(`ns${i % namespaces}`, `op_${i}`),
  );

describe("recommendLevel", () => {
  it("recommends level 1 for a small tool set", () => {
    expect(recommendLevel(build(2, 3)).level).toBe(1);
  });

  // These two assertions were inverted in the first draft: they asserted that
  // level 3 is never recommended, on the assumption that opaque codes cost
  // accuracy. 150 benchmark runs measured no accuracy penalty (48/48 correct,
  // 0 hallucinated names), so the assumption was wrong and the tests now
  // describe measured behaviour. See docs/RESULTS.md and brain decision #5.
  it("never recommends level 2 — it is dominated by level 3 on every axis", () => {
    for (const [ns, ops] of [[2, 3], [6, 10], [10, 20], [1, 200], [20, 1]] as const) {
      expect(recommendLevel(build(ns, ops)).level).not.toBe(2);
    }
  });

  it("recommends level 3 once namespaces are deep enough to amortise", () => {
    expect(recommendLevel(build(6, 12)).level).toBe(3);
  });

  it("discloses the turn cost when it recommends level 3", () => {
    const r = recommendLevel(build(6, 12));
    expect(r.reason).toMatch(/turn/i);
  });

  it("stays at level 1 for a wide, sparse tool set", () => {
    // Many namespaces with one op each: level 2's per-namespace boilerplate
    // would cost more than it saves.
    expect(recommendLevel(build(20, 1)).level).toBe(1);
  });

  it("always returns a reason a human can act on", () => {
    const r = recommendLevel(build(6, 12));
    expect(r.reason).toBeTruthy();
    expect(r.reason.length).toBeGreaterThan(20);
  });

  it("its recommendation is never larger than the alternatives it rejected", () => {
    for (const [ns, ops] of [[2, 3], [6, 12], [20, 1], [3, 40]] as const) {
      const tools = build(ns, ops);
      const rec = recommendLevel(tools);
      const chosen = compress(tools, { level: rec.level }).stats.compressedChars;
      const l1 = compress(tools, { level: 1 }).stats.compressedChars;
      expect(chosen).toBeLessThanOrEqual(l1);
    }
  });
});
