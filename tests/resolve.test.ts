import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        title: { type: "string", description: "Issue title" },
        labels: { type: "array", items: { type: "string" }, description: "Labels" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "slack_post_message",
    description: "Post a message to a Slack channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel id" },
        text: { type: "string", description: "Message text" },
      },
      required: ["channel", "text"],
    },
  },
];

const ARGS = { owner: "acme", repo: "web", title: "Bug" };

describe.each([0, 1, 2, 3] as const)("round-trip at level %i", (level) => {
  const r = compress(TOOLS, { level });

  it("resolves a well-formed call back to the real tool and args", () => {
    const raw = r.encodeCallForTest("github_create_issue", ARGS);
    const res = r.resolve(raw.name, raw.args);
    expect(res.kind).toBe("call");
    if (res.kind !== "call") return;
    expect(res.name).toBe("github_create_issue");
    expect(res.args).toEqual(ARGS);
  });

  it("round-trips every tool in the set", () => {
    for (const t of TOOLS) {
      const args = Object.fromEntries(
        (t.inputSchema.required ?? []).map((k) => [k, "x"]),
      );
      const raw = r.encodeCallForTest(t.name, args);
      const res = r.resolve(raw.name, raw.args);
      expect(res.kind).toBe("call");
      if (res.kind === "call") expect(res.name).toBe(t.name);
    }
  });

  it("rejects a missing required parameter", () => {
    const raw = r.encodeCallForTest("github_create_issue", { owner: "acme" });
    const res = r.resolve(raw.name, raw.args);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/required/i);
  });

  it("rejects an unknown parameter", () => {
    const raw = r.encodeCallForTest("github_create_issue", { ...ARGS, nope: 1 });
    const res = r.resolve(raw.name, raw.args);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/unknown parameter/i);
  });

  it("returns a recoverable error for a hallucinated tool", () => {
    const res = r.resolve("totally_made_up", {});
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    // The message must point the model at the recovery path, not just fail.
    expect(res.message.length).toBeGreaterThan(10);
    expect(res.recoverable).toBe(true);
  });
});

describe("meta calls", () => {
  it("level 2 describe_op returns the real signature", () => {
    const r = compress(TOOLS, { level: 2 });
    const res = r.resolve("describe_op", { ns: "github", op: "create_issue" });
    expect(res.kind).toBe("meta");
    if (res.kind === "meta") {
      expect(res.result).toContain("github_create_issue(");
      expect(res.result).toContain("owner");
    }
  });

  it("level 3 q expands a code to its full definition", () => {
    const r = compress(TOOLS, { level: 3 });
    const code = r.codeFor("github_create_issue");
    const res = r.resolve("q", { c: code });
    expect(res.kind).toBe("meta");
    if (res.kind === "meta") expect(res.result).toContain("github_create_issue");
  });

  it("level 3 q searches by keyword", () => {
    const r = compress(TOOLS, { level: 3 });
    const res = r.resolve("q", { s: "slack" });
    expect(res.kind).toBe("meta");
    if (res.kind === "meta") expect(res.result).toMatch(/slack_post_message/);
  });

  it("level 3 q on an unknown code is recoverable, not fatal", () => {
    const r = compress(TOOLS, { level: 3 });
    const res = r.resolve("q", { c: "zz99" });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.recoverable).toBe(true);
  });
});

describe("type coercion at the boundary", () => {
  it("accepts a JSON string for an object-typed argument bag", () => {
    const r = compress(TOOLS, { level: 3 });
    const code = r.codeFor("slack_post_message");
    // Some models emit the nested arg bag as a JSON string rather than an object.
    const res = r.resolve("t", { f: code, a: '{"channel":"C1","text":"hi"}' } as any);
    expect(res.kind).toBe("call");
    if (res.kind === "call") expect(res.args.channel).toBe("C1");
  });
});
