import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository. Verbose tail here.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "owner" },
        repo: { type: "string", description: "repo" },
        title: { type: "string", description: "title" },
        body: { type: "string", description: "body" },
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
        channel: { type: "string", description: "channel" },
        text: { type: "string", description: "text" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "stripe_get_balance",
    description: "Retrieve the current Stripe account balance.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Extract just the map body. The library tags it `<toolmap>`. */
const mapOf = (preamble: string) => {
  const body = preamble.split("<toolmap>")[1]?.split("</toolmap>")[0];
  if (body === undefined) {
    throw new Error(`no <toolmap> in preamble: ${JSON.stringify(preamble)}`);
  }
  return body.trim();
};

describe("level 3 mapStyle", () => {
  it("defaults to bare names", () => {
    const m = mapOf(compress(TOOLS, { level: 3 }).systemPreamble);
    expect(m).toContain("github_create_issue");
    expect(m).not.toContain("owner,repo,title");
  });

  it("`name` is explicit and identical to the default", () => {
    expect(compress(TOOLS, { level: 3, mapStyle: "name" }).systemPreamble).toBe(
      compress(TOOLS, { level: 3 }).systemPreamble,
    );
  });

  it("`name+required` appends only the required parameters", () => {
    const m = mapOf(
      compress(TOOLS, { level: 3, mapStyle: "name+required" }).systemPreamble,
    );
    // required listed...
    expect(m).toMatch(/github_create_issue owner,repo,title/);
    // ...optional not listed
    expect(m).not.toContain("body");
    // a tool with no params gets no trailing separator
    expect(m).toMatch(/stripe_get_balance$|stripe_get_balance\n/);
  });

  it("`terse` carries a shortened description instead of the name", () => {
    const m = mapOf(compress(TOOLS, { level: 3, mapStyle: "terse" }).systemPreamble);
    expect(m).not.toContain("github_create_issue");
    expect(m.toLowerCase()).toContain("issue");
  });

  it("rejects an unknown mapStyle rather than silently defaulting", () => {
    expect(() =>
      compress(TOOLS, { level: 3, mapStyle: "banana" as any }),
    ).toThrow(/mapStyle/i);
  });

  it("is ignored below level 3 (no preamble to carry it)", () => {
    for (const level of [0, 1, 2] as const) {
      expect(
        compress(TOOLS, { level, mapStyle: "name+required" }).systemPreamble,
      ).toBe(compress(TOOLS, { level }).systemPreamble);
    }
  });

  it("every style still round-trips a call to the real tool and args", () => {
    for (const mapStyle of ["name", "name+required", "terse"] as const) {
      const c = compress(TOOLS, { level: 3, mapStyle });
      const raw = c.encodeCallForTest("github_create_issue", {
        owner: "acme",
        repo: "web",
        title: "T",
      });
      const r = c.resolve(raw.name, raw.args);
      expect(r.kind, mapStyle).toBe("call");
      if (r.kind === "call") expect(r.name).toBe("github_create_issue");
    }
  });

  it("stays byte-deterministic per style", () => {
    for (const mapStyle of ["name", "name+required", "terse"] as const) {
      const a = compress(TOOLS, { level: 3, mapStyle });
      const b = compress(TOOLS, { level: 3, mapStyle });
      expect(JSON.stringify(a.tools) + a.systemPreamble).toBe(
        JSON.stringify(b.tools) + b.systemPreamble,
      );
    }
  });

  it("name+required costs more than name but far less than full schemas", () => {
    const name = compress(TOOLS, { level: 3, mapStyle: "name" }).stats.compressedChars;
    const plus = compress(TOOLS, { level: 3, mapStyle: "name+required" }).stats.compressedChars;
    const l1 = compress(TOOLS, { level: 1 }).stats.compressedChars;
    expect(plus).toBeGreaterThan(name);
    expect(plus).toBeLessThan(l1);
  });
});
