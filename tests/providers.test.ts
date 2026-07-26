import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import { forAnthropic, forOpenAI, forGemini } from "../src/providers/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description: "Create an issue.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string", description: "d" } },
      required: ["owner"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
  },
  {
    name: "slack_post_message",
    description: "Post a message.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "d" } },
      required: ["channel"],
    },
  },
];

describe("forAnthropic", () => {
  it("puts exactly one cache breakpoint on the last tool", () => {
    const { tools } = forAnthropic(compress(TOOLS, { level: 1 }));
    const marked = tools.filter((t) => t.cache_control);
    expect(marked).toHaveLength(1);
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("honours an explicit ttl", () => {
    const { tools } = forAnthropic(compress(TOOLS, { level: 1 }), { ttl: "1h" });
    expect(tools.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("places no breakpoint when caching is off", () => {
    const { tools } = forAnthropic(compress(TOOLS, { level: 1 }), { cache: false });
    expect(tools.some((t) => t.cache_control)).toBe(false);
  });

  it("never marks a tool carrying defer_loading — the API rejects that pairing", () => {
    const c = compress(TOOLS, { level: 1 });
    (c.tools as any[])[1].defer_loading = true;
    const { tools } = forAnthropic(c);
    expect(tools[1].cache_control).toBeUndefined();
    expect(tools[0].cache_control).toBeDefined();
  });

  it("emits a cached system block only when the level produces a preamble", () => {
    expect(forAnthropic(compress(TOOLS, { level: 1 })).system).toBeUndefined();
    const l3 = forAnthropic(compress(TOOLS, { level: 3 }));
    expect(l3.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(l3.system[0].text).toMatch(/<toolmap>/);
  });

  it("does not mutate the CompressResult it was given", () => {
    const c = compress(TOOLS, { level: 1 });
    forAnthropic(c);
    expect((c.tools as any[]).some((t) => t.cache_control)).toBe(false);
  });
});

describe("forOpenAI", () => {
  const { tools } = forOpenAI(compress(TOOLS, { level: 1 }));

  it("wraps each tool in the function envelope", () => {
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("github_create_issue");
    expect(tools[0].function.parameters.type).toBe("object");
  });

  it("drops Anthropic server-side tools, which have no OpenAI equivalent", () => {
    const c = compress(TOOLS, { level: 1 });
    (c.tools as any[]).push({ type: "tool_search_tool_regex_20251119", name: "s" });
    expect(forOpenAI(c).tools).toHaveLength(TOOLS.length);
  });
});

describe("forGemini", () => {
  it("emits a single functionDeclarations array", () => {
    const { tools } = forGemini(compress(TOOLS, { level: 1 }));
    expect(tools).toHaveLength(1);
    expect(tools[0].functionDeclarations).toHaveLength(TOOLS.length);
  });

  it("strips keywords Gemini rejects", () => {
    const { tools } = forGemini(compress(TOOLS, { level: 0 }));
    const p = tools[0].functionDeclarations[0].parameters;
    expect(p.additionalProperties).toBeUndefined();
    expect(p.$schema).toBeUndefined();
  });
});

describe("forGemini repairs schemas Gemini rejects outright", () => {
  /**
   * Gemini rejects the ENTIRE request if any one tool declaration is invalid, so a
   * single non-conforming tool anywhere in a catalogue breaks every call. Three forms
   * appear in real MCP servers and all three were found by pointing the adapter at the
   * committed 149-tool corpus:
   *
   *   1. an array with no `items`     — 7 tools, e.g. analyze_consolidation.shipments
   *      400 ...properties[shipments].items: missing field
   *   2. `enum` on a non-string type  — deep_research.depth is {number, enum:[1,2,3]}
   *      400 Invalid value at ...parameters.properties[2]
   *   3. a union type                 — send_email_with_attachments.cc is
   *      {"type":["string","array"]}; Gemini needs a single type string
   *
   * Acceptance was verified against the live API at levels 0-3 on all 149 tools. These
   * tests are offline and assert the emitted SHAPE, so the guarantee survives in CI
   * without spending money.
   */
  const walk = (node: any, path: string, hit: (n: any, p: string) => void) => {
    if (!node || typeof node !== "object") return;
    hit(node, path);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, hit);
  };
  const declsFor = async (level: 0 | 1 | 2 | 3) => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const g: any = forGemini(compress(REAL_TOOLS as any, { level }));
    return { decls: g.tools[0].functionDeclarations as any[], REAL_TOOLS };
  };

  for (const level of [0, 1, 2, 3] as const) {
    it(`level ${level}: emits no array without \`items\``, async () => {
      const { decls } = await declsFor(level);
      const bad: string[] = [];
      decls.forEach((d) =>
        walk(d.parameters, d.name, (n, p) => {
          if (n.type === "array" && n.items === undefined) bad.push(p);
        }),
      );
      expect(bad, `arrays missing items: ${bad.join(", ")}`).toEqual([]);
    });

    it(`level ${level}: emits no enum on a non-string type`, async () => {
      const { decls } = await declsFor(level);
      const bad: string[] = [];
      decls.forEach((d) =>
        walk(d.parameters, d.name, (n, p) => {
          if (n.enum && n.type && n.type !== "string") bad.push(`${p} (${n.type})`);
        }),
      );
      expect(bad, `non-string enums: ${bad.join(", ")}`).toEqual([]);
    });

    it(`level ${level}: emits no union type`, async () => {
      const { decls } = await declsFor(level);
      const bad: string[] = [];
      decls.forEach((d) =>
        walk(d.parameters, d.name, (n, p) => {
          if (Array.isArray(n.type)) bad.push(`${p} (${JSON.stringify(n.type)})`);
        }),
      );
      expect(bad, `union types: ${bad.join(", ")}`).toEqual([]);
    });
  }

  it("the corpus really does contain all three forms — or these tests prove nothing", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    let arrays = 0, enums = 0, unions = 0;
    for (const t of REAL_TOOLS as any[]) {
      walk(t.input_schema, t.name, (n) => {
        if (n.type === "array" && n.items === undefined) arrays++;
        if (n.enum && n.type && n.type !== "string" && !Array.isArray(n.type)) enums++;
        if (Array.isArray(n.type)) unions++;
      });
    }
    expect(arrays, "corpus should contain arrays missing items").toBeGreaterThan(0);
    expect(enums, "corpus should contain a non-string enum").toBeGreaterThan(0);
    expect(unions, "corpus should contain a union type").toBeGreaterThan(0);
  });

  it("does not mutate the caller's schemas", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const before = JSON.stringify(REAL_TOOLS);
    forGemini(compress(REAL_TOOLS as any, { level: 1 }));
    expect(JSON.stringify(REAL_TOOLS)).toBe(before);
  });

  it("still enforces a constraint it had to drop for Gemini", async () => {
    // depth is {number, enum:[1,2,3]}. The enum cannot reach Gemini, so validateArgs
    // must catch a violation instead — otherwise dropping it would lose the constraint.
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const c = compress(REAL_TOOLS as any, { level: 1 });
    const r = c.resolve("deep_research", { query: "x", depth: 99 });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/depth/);
  });

  it("is byte-deterministic — the repair must not break the prompt cache", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const runs = [1, 2, 3].map(() =>
      JSON.stringify(forGemini(compress(REAL_TOOLS as any, { level: 1 })).tools),
    );
    expect(new Set(runs).size).toBe(1);
  });
});
