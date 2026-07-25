/**
 * OpenAI has two tool shapes and they are not interchangeable.
 *
 *   /v1/chat/completions → { type:"function", function:{ name, description, parameters } }
 *   /v1/responses        → { type:"function", name, description, parameters }   (flat)
 *
 * This matters beyond tidiness: on GPT-5.x, `/v1/chat/completions` refuses to
 * combine function tools with reasoning, so anyone who wants tools *and*
 * reasoning must use `/v1/responses` — and would silently send the wrong tool
 * shape if `forOpenAI` were their only option.
 */
import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import { forOpenAI, forOpenAIResponses } from "../src/providers/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description: "Create an issue.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string", description: "d" } },
      required: ["owner"],
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

describe("forOpenAIResponses", () => {
  const { tools, systemPreamble } = forOpenAIResponses(compress(TOOLS, { level: 1 }));

  it("emits the flat tool shape, not the nested one", () => {
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("github_create_issue");
    expect(tools[0].parameters?.type).toBe("object");
    // The nested envelope must be absent — that is the whole point.
    expect((tools[0] as any).function).toBeUndefined();
  });

  it("differs from forOpenAI, which stays nested for chat completions", () => {
    const chat = forOpenAI(compress(TOOLS, { level: 1 })).tools;
    expect((chat[0] as any).function.name).toBe("github_create_issue");
    expect((chat[0] as any).name).toBeUndefined();
  });

  it("carries description and one entry per tool", () => {
    expect(tools).toHaveLength(TOOLS.length);
    expect(typeof tools[0].description).toBe("string");
  });

  it("passes the level-3 preamble through untouched", () => {
    const c3 = compress(TOOLS, { level: 3 });
    const r = forOpenAIResponses(c3);
    expect(r.systemPreamble).toBe(c3.systemPreamble);
    expect(r.systemPreamble).toMatch(/<toolmap>/);
    expect(r.tools.map((t) => t.name).sort()).toEqual(["q", "t"]);
  });

  it("has no preamble at levels 0–1", () => {
    expect(systemPreamble).toBe("");
  });

  it("drops Anthropic server-side tools, which have no OpenAI equivalent", () => {
    const c = compress(TOOLS, { level: 1 });
    (c.tools as any[]).push({ type: "tool_search_tool_regex_20251119", name: "s" });
    expect(forOpenAIResponses(c).tools).toHaveLength(TOOLS.length);
  });

  it("does not mutate the CompressResult", () => {
    const c = compress(TOOLS, { level: 1 });
    const before = JSON.stringify(c.tools);
    forOpenAIResponses(c);
    expect(JSON.stringify(c.tools)).toBe(before);
  });

  it("is deterministic", () => {
    const a = JSON.stringify(forOpenAIResponses(compress(TOOLS, { level: 3 })).tools);
    const b = JSON.stringify(forOpenAIResponses(compress(TOOLS, { level: 3 })).tools);
    expect(a).toBe(b);
  });
});
