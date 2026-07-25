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
