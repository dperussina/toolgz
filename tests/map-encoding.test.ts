/**
 * Experimental codeless map styles.
 *
 * Motivation. Measured with Anthropic count_tokens (not characters — the ranking
 * flips between the two), on 19 real MCP tools pulled from live servers via
 * tools/list, and on the 100-tool synthetic fixture.
 *
 * Map text alone:
 *   names only (floor)          153 / 905
 *   nocode  (name + required)   246 / 1355
 *   grouped (ns: op(required))  284 / 1292
 *   current (code name req)     303 / 1655
 *
 * End to end, tools + system, which is what actually matters:
 *                        real(19)   synth(100)
 *   nocode                793 (-7%)  1887 (-14%)
 *   grouped               846 (-1%)  1720 (-21%)
 *   name (bare)           750 (-12%) 1745 (-20%)
 *   name+required          854        2191   (current default)
 *   @atlassian max         788        1540   (competitor, for scale)
 *
 * Two things to read off that table. The end-to-end saving is smaller than the
 * map-text saving, because the two dispatcher tool definitions are constant
 * overhead that dilutes it. And `grouped` beats bare `name` at 100 tools while
 * still carrying required arguments — strictly more information for fewer tokens.
 *
 * The caveat that matters: `grouped` factors a shared name prefix, and the real
 * MCP servers tested do not use one (their tools are `compute_route`, not
 * `google_maps_compute_route`). Hence -21% synthetic against -1% real. The
 * fixture's ns_op naming over-represents this style's benefit.
 *
 * The saving in `nocode` comes from removing a duplication: the default writes
 * both a code and the real name, so identity is paid for twice. Dropping the code
 * also removes a failure mode observed in real runs — a model calling the map code
 * as the tool name (tests/robustness.test.ts).
 *
 * These are NOT the default. Bare `name` was also smaller and failed
 * deterministically on grok-4.5, so size wins remain hypotheses until the
 * cross-provider accuracy sweep confirms them.
 */
import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    name: "github_search_issues",
    description: "Search issues across GitHub with a query string.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" }, sort: { type: "string" } },
      required: ["q"],
    },
  },
  {
    name: "github_create_issue",
    description: "Open a new issue.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "slack_post_message",
    description: "Post a message to a channel.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, text: { type: "string" } },
      required: ["channel", "text"],
    },
  },
];

const mapOf = (preamble: string) =>
  preamble.slice(preamble.indexOf("<toolmap>") + 9, preamble.indexOf("</toolmap>")).trim();

describe("nocode", () => {
  const c = () => compress(TOOLS, { level: 3, mapStyle: "nocode" });

  it("writes the real name with no code column", () => {
    const map = mapOf(c().systemPreamble);
    expect(map).toContain("github_search_issues q");
    // A leading two-char code would mean the duplication is still being paid.
    for (const line of map.split("\n")) expect(line).not.toMatch(/^[a-z]\d\s/);
  });

  it("dispatches on the tool's own name", () => {
    const k = c();
    const r = k.resolve("t", { f: "github_search_issues", a: { q: "leak" } });
    expect(r.kind).toBe("call");
    if (r.kind === "call") {
      expect(r.name).toBe("github_search_issues");
      expect(r.args).toEqual({ q: "leak" });
    }
  });

  it("codeFor returns the name itself, so callers need no special case", () => {
    expect(c().codeFor("slack_post_message")).toBe("slack_post_message");
  });

  it("q() expands a name", () => {
    const r = c().resolve("q", { c: "github_create_issue" });
    expect(r.kind).toBe("meta");
    if (r.kind === "meta") expect(r.result).toContain("github_create_issue");
  });

  it("tells the model to pass a name, not a code", () => {
    const p = c().systemPreamble;
    expect(p).toContain("t(f=<name>");
    expect(p).not.toContain("t(f=<code>");
  });

  it("still validates against the original schema", () => {
    const r = c().resolve("t", { f: "github_search_issues", a: { query: "leak" } });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/did you mean/i);
  });

  it("is smaller than the shipped default", () => {
    const a = compress(TOOLS, { level: 3, mapStyle: "name+required" });
    expect(mapOf(c().systemPreamble).length).toBeLessThan(mapOf(a.systemPreamble).length);
  });
});

describe("grouped", () => {
  const c = () => compress(TOOLS, { level: 3, mapStyle: "grouped" });

  it("factors the namespace prefix out of each line", () => {
    const map = mapOf(c().systemPreamble);
    expect(map).toMatch(/^github: /m);
    expect(map).toMatch(/^slack: /m);
    // The prefix must appear once per namespace, not once per tool.
    expect(map.split("github").length - 1).toBe(1);
  });

  it("keeps required args per operation", () => {
    expect(mapOf(c().systemPreamble)).toContain("create_issue(owner,repo,title)");
  });

  it("dispatches on the full name", () => {
    const r = c().resolve("t", { f: "slack_post_message", a: { channel: "#a", text: "hi" } });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("slack_post_message");
  });

  it("also accepts the bare op, since that is what the map shows", () => {
    const r = c().resolve("t", { f: "post_message", a: { channel: "#a", text: "hi" } });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("slack_post_message");
  });

  it("documents how to rebuild a full name from a grouped line", () => {
    expect(c().systemPreamble).toContain("namespace_op");
  });

  it("does not alias an op that two namespaces share", () => {
    // `list` is ambiguous here, so it must not silently resolve to either tool.
    const ambiguous: Tool[] = [
      { name: "github_list", description: "x", inputSchema: { type: "object", properties: {} } },
      { name: "slack_list", description: "y", inputSchema: { type: "object", properties: {} } },
    ];
    const k = compress(ambiguous, { level: 3, mapStyle: "grouped" });
    expect(k.resolve("t", { f: "list", a: {} }).kind).toBe("error");
    expect(k.resolve("t", { f: "github_list", a: {} }).kind).toBe("call");
  });

  it("emits one line per namespace, not per tool", () => {
    expect(mapOf(c().systemPreamble).split("\n").length).toBe(2);
  });
});

describe("existing styles are untouched", () => {
  it("the default still carries a code column", () => {
    const map = mapOf(compress(TOOLS, { level: 3 }).systemPreamble);
    expect(map).toMatch(/^[a-z]\d github_search_issues q$/m);
  });

  it("the default still dispatches by code", () => {
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", { f: k.codeFor("github_search_issues"), a: { q: "x" } });
    expect(r.kind).toBe("call");
  });

  it("an unknown mapStyle is still rejected", () => {
    expect(() => compress(TOOLS, { level: 3, mapStyle: "nope" as any })).toThrow(/unsupported mapStyle/);
  });
});
