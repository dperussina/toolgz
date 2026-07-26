import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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


  it("discloses the turn cost when it recommends level 3", async () => {
    // build(6,12) used to trigger level 3 via the namespace-shape rule. It is 72 tools
    // with a one-property schema — only ~4,900 tokens, about 2.5% of a 200k window — so
    // level 1 is now correct for it and a realistic corpus is needed to exercise level 3.
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const r = recommendLevel(REAL_TOOLS as any);
    expect(r.level).toBe(3);
    expect(r.reason).toMatch(/turn/i);
  });

  it("many tools with trivial schemas correctly stay at level 1", () => {
    // Tool COUNT is not the variable; block SIZE is. 72 tools whose schemas are one
    // string property do not threaten anyone's context budget, and level 1 keeps the
    // provider's argument validation.
    const r = recommendLevel(build(6, 12));
    expect(r.level).toBe(1);
    expect(r.toolCount).toBe(72);
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

describe("recommendLevel sizes the block instead of testing its shape", () => {
  /**
   * The regression this exists for: the old heuristic gated level 3 on
   * `opsPerNamespace >= 4`, which is a LEVEL-2 question — level 2 pays dispatcher
   * overhead per namespace, level 3 uses one flat dispatcher and does not care.
   *
   * Real MCP tool names are verb-first (probe_url, discover_api), so splitting on the
   * first underscore produces many tiny namespaces: the 149-tool corpus has 63 of them
   * at 2.4 ops each. The old rule therefore recommended level 1 at 41,648 tokens where
   * level 3 measures 2,980 — leaving ~38,700 tokens unclaimed on our own flagship corpus.
   *
   * Measured on real tools, level 3 is smaller at EVERY count tested, down to 5 tools
   * (635 vs 1,178). Size never argues for level 1; keeping the provider's own argument
   * validation does, which is why the threshold is absolute rather than shape-based.
   */
  it("recommends level 3 for the real 149-tool corpus", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const r = recommendLevel(REAL_TOOLS as any);
    expect(r.level, `63 namespaces at 2.4 ops each must not veto level 3`).toBe(3);
  });

  it("is not fooled by a sparse namespace distribution", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const r = recommendLevel(REAL_TOOLS as any);
    // The shape that used to trigger the wrong answer is still present.
    expect(r.opsPerNamespace).toBeLessThan(4);
    expect(r.level).toBe(3);
  });

  it("keeps level 1 for a block small enough that validation matters more", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const r = recommendLevel(REAL_TOOLS.slice(0, 8) as any);
    expect(r.level).toBe(1);
    expect(r.reason).toMatch(/validation/i);
  });

  it("does not push a 14-tool set into dispatcher mode", async () => {
    // An external reviewer flagged this: a 4,000-token threshold sent 14-tool sets to
    // level 3, losing provider-side validation for a saving that does not change what
    // fits in a 200k window. The threshold is now ~10,000 tokens, about 5% of one.
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    expect(recommendLevel(REAL_TOOLS.slice(0, 14) as any).level).toBe(1);
  });

  it("estimates the level-1 block within 5% of a real token count", async () => {
    // 149 real tools measure 41,648 tokens via count_tokens. The estimate must track it;
    // an earlier version rebuilt the schema by hand and overshot by ~34%.
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const est = Number(
      recommendLevel(REAL_TOOLS as any).reason.match(/~([\d,]+) tokens/)![1].replace(/,/g, ""),
    );
    expect(Math.abs(est - 41648) / 41648).toBeLessThan(0.05);
  });
});

describe("recommendLevel advises; compress() never acts on its own", () => {
  /**
   * A reader of the README asked whether the library "upgrades to level 3
   * automatically if they have a lot of tools." It does not, and the docs at the time
   * invited the reading: the quick start commented `// 1 for small sets, 3 for large
   * ones` on a line that merely *computes* a number, and example 01 called it
   * "let the library pick."
   *
   * The behaviour is deliberate — level 3 gives up provider-side schema enforcement,
   * so upgrading silently because a caller's tool array grew would change their
   * correctness guarantees behind their back. But it is only safe as a default if it
   * is loudly documented, so these tests pin the behaviour AND the prose together.
   */
  const bigBlock: Tool[] = Array.from({ length: 300 }, (_, i) => ({
    name: `svc${i % 9}_operation_number_${i}`,
    description: `Operation ${i}. ${"Prose the model does not need to choose correctly. ".repeat(4)}`,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "The thing to act on." },
        limit: { type: "integer", description: "How many results." },
      },
      required: ["target"],
    },
  }));

  it("stays at level 1 on a block big enough to be recommended level 3", () => {
    expect(recommendLevel(bigBlock).level, "precondition: this block wants level 3").toBe(3);
    expect(compress(bigBlock).stats.level, "compress() must not follow the advice by itself").toBe(1);
  });

  it("reaches level 3 only when the caller passes the advice back in", () => {
    const { level } = recommendLevel(bigBlock);
    expect(compress(bigBlock, { level }).stats.level).toBe(3);
  });

  it("leaves a real saving unclaimed, which is the cost of the guarantee", () => {
    // Not a defect to fix — the number is here so the trade stays visible, and so
    // anyone tempted to make compress() self-select sees what they would be buying.
    expect(compress(bigBlock, { level: 3 }).stats.savedPct).toBeGreaterThan(
      compress(bigBlock).stats.savedPct + 20,
    );
  });

  it("the default holds at every size, so there is no hidden cliff", () => {
    for (const n of [1, 2, 15, 50, 150, 500]) {
      expect(compress(bigBlock.slice(0, n)).stats.level, `${n} tools`).toBe(1);
    }
  });

  it("the README says so, in the quick start and the API reference", () => {
    const readme = readFileSync("README.md", "utf8");
    // The quick start must not imply the call itself chooses.
    expect(readme).not.toMatch(/recommendLevel\(myTools\);\s*\/\/\s*1 for small sets/);
    expect(readme).toMatch(/only advises|advises; it does not act|advises, it does\s*\n?not act/i);
    // And the size-not-count basis must be stated, since that was the other half of
    // the misreading.
    expect(readme).toMatch(/how \*big\* the block is, not how \*many\*/);
  });

  it("no doc still describes the removed tools-per-namespace gate as current", () => {
    for (const f of ["README.md", "src/recommend.ts"]) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/threshold is driven by tools-per-namespace/.test(line)) return;
        const context = lines.slice(Math.max(0, i - 3), i + 3).join(" ");
        expect(/earlier version|old heuristic|used to|no longer/i.test(context), `${f}:${i + 1}`).toBe(true);
      });
    }
  });
});
