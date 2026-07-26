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
  // The default was "name" until the cross-provider sweep: grok-4.5 answered
  // one scenario with zero tool calls on 3/3 reps under bare names, and
  // "name+required" fixed it 3/3 while also being perfect on the other three
  // providers. Measurement changed the default; see docs/RESULTS.md.
  it("defaults to name+required", () => {
    const m = mapOf(compress(TOOLS, { level: 3 }).systemPreamble);
    expect(m).toContain("github_create_issue owner,repo,title");
  });

  it("`name+required` is explicit and identical to the default", () => {
    expect(
      compress(TOOLS, { level: 3, mapStyle: "name+required" }).systemPreamble,
    ).toBe(compress(TOOLS, { level: 3 }).systemPreamble);
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

  
  it("rejects an unknown mapStyle rather than silently defaulting", () => {
    expect(() =>
      compress(TOOLS, { level: 3, mapStyle: "banana" as any }),
    ).toThrow(/mapStyle/i);
  });

  it("is ignored below level 3 (no preamble to carry it)", () => {
    for (const level of [0, 1, 2] as const) {
      expect(
        compress(TOOLS, { level, mapStyle: "explicit" }).systemPreamble,
      ).toBe(compress(TOOLS, { level }).systemPreamble);
    }
  });

  it("every style still round-trips a call to the real tool and args", () => {
    for (const mapStyle of ["name+required", "explicit", "signature"] as const) {
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
    for (const mapStyle of ["name+required", "explicit", "signature"] as const) {
      const a = compress(TOOLS, { level: 3, mapStyle });
      const b = compress(TOOLS, { level: 3, mapStyle });
      expect(JSON.stringify(a.tools) + a.systemPreamble).toBe(
        JSON.stringify(b.tools) + b.systemPreamble,
      );
    }
  });

  it("every style is far below full schemas — at a realistic tool count", async () => {
    // Deliberately NOT on the 2-tool fixture. Level 3 ships two dispatcher tools, a
    // map and a legend, and that fixed overhead exceeds level 1 on a handful of
    // tools: 797 chars against 733 here. That is why recommendLevel steers small
    // catalogues to level 1 rather than 3, and the next test pins it.
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const l1 = compress(REAL_TOOLS as any, { level: 1 }).stats.compressedChars;
    for (const mapStyle of ["name+required", "explicit", "signature"] as const) {
      const l3 = compress(REAL_TOOLS as any, { level: 3, mapStyle }).stats.compressedChars;
      expect(l3, mapStyle).toBeLessThan(l1 / 2);
    }
  });

  it("recommends level 1, not 3, for a catalogue too small to amortise the dispatcher", async () => {
    const { recommendLevel } = await import("../src/recommend.js");
    expect(recommendLevel(TOOLS as any).level).toBe(1);
  });

  it("explicit adds to the MAP, not necessarily to the whole preamble", () => {
    // Compare map content, not compressedChars. Each style ships a different legend,
    // and that fixed overhead outranks the per-line difference on a small fixture:
    // on two tools `explicit` totals 765 chars against `signature`'s 719 purely
    // because its legend is longer. Per-tool cost is what scales.
    const mapOf = (p: string) => p.slice(p.indexOf("<toolmap>"), p.indexOf("</toolmap>"));
    const zeroReq = [
      ...TOOLS,
      { name: "svc_no_required", description: "d", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
    ];
    const plus = mapOf(compress(zeroReq as any, { level: 3 }).systemPreamble).length;
    const explicit = mapOf(compress(zeroReq as any, { level: 3, mapStyle: "explicit" }).systemPreamble).length;
    // Exactly " ()" — three characters — per zero-required tool, and nothing else.
    // Derived rather than hard-coded: the fixture's shape should not be able to make
    // this pass or fail by accident.
    const zeroReqCount = (zeroReq as any[]).filter(
      (t) => !(t.inputSchema.required ?? []).length,
    ).length;
    expect(zeroReqCount).toBeGreaterThan(0);
    expect(explicit - plus).toBe(3 * zeroReqCount);
    // And the line for a tool that DOES declare required args is untouched. Compare
    // that line, not the whole map: this fixture also contains a zero-required tool,
    // so the maps legitimately differ.
    const lineFor = (style: any, name: string) =>
      mapOf(compress(TOOLS, { level: 3, mapStyle: style }).systemPreamble)
        .split("\n")
        .find((l) => l.includes(name));
    expect(lineFor("explicit", "github_create_issue")).toBe(
      lineFor("name+required", "github_create_issue"),
    );
  });
});
