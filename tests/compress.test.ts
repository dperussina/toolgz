import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

function mk(ns: string, op: string, params: string[] = ["a"]): Tool {
  return {
    name: `${ns}_${op}`,
    description: `Perform the ${op} operation against ${ns}. This description is deliberately verbose so that compression has something to remove.`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        params.map((p) => [p, { type: "string", description: `The ${p} parameter, described at length.` }]),
      ),
      required: [params[0]],
      additionalProperties: false,
    },
  };
}

const TOOLS: Tool[] = [
  mk("github", "create_issue", ["owner", "repo", "title"]),
  mk("github", "list_issues", ["owner", "repo"]),
  mk("github", "get_issue", ["owner", "repo", "number"]),
  mk("slack", "post_message", ["channel", "text"]),
  mk("slack", "list_channels", ["limit"]),
];

describe("compress — contract", () => {
  it("rejects an unknown level", () => {
    expect(() => compress(TOOLS, { level: 9 as any })).toThrow(/level/i);
  });

  it("rejects duplicate tool names", () => {
    expect(() => compress([TOOLS[0], TOOLS[0]], { level: 0 })).toThrow(/duplicate/i);
  });

  it("returns a stable tool ordering regardless of input order", () => {
    const a = compress(TOOLS, { level: 1 });
    const b = compress([...TOOLS].reverse(), { level: 1 });
    expect(a.tools.map((t: any) => t.name)).toEqual(b.tools.map((t: any) => t.name));
  });

  it("produces an identical payload across calls (cache prefix stability)", () => {
    const a = JSON.stringify(compress(TOOLS, { level: 1 }).tools);
    const b = JSON.stringify(compress(TOOLS, { level: 1 }).tools);
    expect(a).toBe(b);
  });
});

describe("compress — level 0 (passthrough)", () => {
  it("emits every tool unchanged", () => {
    const { tools, stats } = compress(TOOLS, { level: 0 });
    expect(tools).toHaveLength(TOOLS.length);
    expect(stats.level).toBe(0);
  });
});

describe("compress — level 1 (signature flattening)", () => {
  const r = compress(TOOLS, { level: 1 });

  it("keeps one native tool per input tool", () => {
    expect(r.tools).toHaveLength(TOOLS.length);
  });

  it("keeps full semantic names", () => {
    expect(r.tools.map((t: any) => t.name).sort()).toEqual(
      TOOLS.map((t) => t.name).sort(),
    );
  });

  it("reports a positive saving", () => {
    expect(r.stats.compressedChars).toBeLessThan(r.stats.originalChars);
    expect(r.stats.savedPct).toBeGreaterThan(0);
  });

  it("preserves constrained decoding by keeping a real inputSchema", () => {
    for (const t of r.tools as any[]) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.properties).toBeDefined();
    }
  });
});

describe("compress — level 2 (namespace collapse)", () => {
  const r = compress(TOOLS, { level: 2 });

  it("collapses to one tool per namespace plus a describe tool", () => {
    const names = r.tools.map((t: any) => t.name);
    expect(names).toContain("github");
    expect(names).toContain("slack");
    expect(names).toContain("describe_op");
    expect(r.tools.length).toBeLessThan(TOOLS.length);
  });

  it("enumerates ops as an enum so the sampler stays constrained", () => {
    const gh: any = r.tools.find((t: any) => t.name === "github");
    expect(gh.input_schema.properties.op.enum).toEqual(
      expect.arrayContaining(["create_issue", "list_issues", "get_issue"]),
    );
  });
});

describe("compress — level 3 (minified)", () => {
  const r = compress(TOOLS, { level: 3 });

  it("exposes only a dispatcher and a query tool", () => {
    expect(r.tools.map((t: any) => t.name).sort()).toEqual(["q", "t"]);
  });

  it("emits a map in the system preamble", () => {
    expect(r.systemPreamble).toMatch(/<toolmap>/);
    expect(r.systemPreamble.length).toBeGreaterThan(0);
  });

  it("marks the preamble as cacheable", () => {
    expect(r.cachePreamble).toBe(true);
  });
});

describe("compress — size behaviour across levels", () => {
  const many: Tool[] = Array.from({ length: 60 }, (_, i) =>
    mk(`ns${i % 6}`, `op_${i}`, ["alpha", "beta", "gamma"]),
  );
  const size = (tools: Tool[], level: number) =>
    compress(tools, { level: level as any }).stats.compressedChars;

  it("is monotonic at a realistic tool count", () => {
    const sizes = [0, 1, 2, 3].map((l) => size(many, l));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    }
  });

  it("level 2's win is driven by tools-per-namespace, not raw tool count", () => {
    // Level 2 emits one wire tool per namespace plus describe_op. That
    // boilerplate is paid per *namespace*, so a wide-and-sparse tool set
    // (many namespaces, few ops each) can come out LARGER than level 1 while
    // a narrow-and-deep set of the same size comes out much smaller.
    // `recommendLevel()` encodes this ratio.
    const sparse = Array.from({ length: 6 }, (_, i) => mk(`ns${i}`, `op_${i}`, ["a", "b", "c"]));
    const deep = Array.from({ length: 6 }, (_, i) => mk("one", `op_${i}`, ["a", "b", "c"]));

    expect(size(sparse, 2)).toBeGreaterThan(size(sparse, 1)); // 6 ns / 1 op each
    expect(size(deep, 2)).toBeLessThan(size(deep, 1));        // 1 ns / 6 ops
    expect(size(many, 2)).toBeLessThan(size(many, 1));        // 6 ns / 10 ops each
  });

  it("level 3 is the smallest at every tool count", () => {
    for (const tools of [TOOLS, many]) {
      const s = [0, 1, 2, 3].map((l) => size(tools, l));
      expect(Math.min(...s)).toBe(s[3]);
    }
  });

  it("level 1 always beats level 0 — flattening has no fixed overhead", () => {
    expect(size(TOOLS, 1)).toBeLessThan(size(TOOLS, 0));
    expect(size(many, 1)).toBeLessThan(size(many, 0));
  });
});
