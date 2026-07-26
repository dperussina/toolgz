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

  it("factors the namespace prefix out of a namespace with several tools", () => {
    const map = mapOf(c().systemPreamble);
    expect(map).toMatch(/^github: /m);
    // The prefix must appear once per namespace, not once per tool.
    expect(map.split("github").length - 1).toBe(1);
  });

  it("leaves a single-tool namespace as a complete name", () => {
    // `slack` has one tool here. `slack: post_message(...)` is longer than the
    // real name, so factoring it would cost tokens and add a reconstruction step
    // for nothing.
    const map = mapOf(c().systemPreamble);
    expect(map).not.toMatch(/^slack: /m);
    expect(map).toContain("slack_post_message");
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

describe("namespaceOf contract is enforced", () => {
  // Found by getting it wrong while benchmarking: the callback takes a name and
  // returns { ns, op }, but returning a bare namespace string is the natural
  // mistake. That used to fail silently — every tool collapsed into one
  // `undefined` namespace, and the first symptom was Anthropic rejecting a tool
  // with an empty name, which points nowhere near the cause.
  it("rejects a callback that returns a bare string", () => {
    expect(() =>
      compress(TOOLS, { level: 2, namespaceOf: ((n: string) => "github") as any }),
    ).toThrow(/must return \{ ns, op \}/);
  });

  it("names the offending tool and shows a correct example", () => {
    try {
      compress(TOOLS, { level: 2, namespaceOf: ((n: string) => "x") as any });
      throw new Error("should have thrown");
    } catch (e: any) {
      // The first tool processed is the one reported.
      expect(e.message).toContain("github_search_issues");
      expect(e.message).toContain("ns: serverOf(name)");
    }
  });

  it("rejects empty ns or op rather than emitting an unnamed tool", () => {
    expect(() =>
      compress(TOOLS, { level: 2, namespaceOf: (() => ({ ns: "", op: "x" })) as any }),
    ).toThrow(/non-empty strings/);
    expect(() =>
      compress(TOOLS, { level: 2, namespaceOf: (() => ({ ns: "a", op: "" })) as any }),
    ).toThrow(/non-empty strings/);
  });

  it("accepts a correct custom namespaceOf", () => {
    const k = compress(TOOLS, {
      level: 3,
      mapStyle: "grouped",
      namespaceOf: (name: string) => ({ ns: name.startsWith("github") ? "gh" : "sl", op: name }),
    });
    expect(k.systemPreamble).toContain("gh:");
    expect(k.resolve("t", { f: "slack_post_message", a: { channel: "#a", text: "b" } }).kind).toBe("call");
  });
});

describe("observed on gpt-5.6-sol: namespace joined with a dot, not an underscore", () => {
  /**
   * Every failure of the `grouped` arm on gpt-5.6-sol in the 432-run real-tool
   * sweep was this, and nothing else. The map prints `gdrive: sheets_append_rows`
   * and the model reassembled the name with a DOT — the ordinary convention for
   * qualified identifiers — where the real tool uses an underscore. Verified not
   * to be rate limiting: zero of 369 runs recorded an API error.
   *
   * Actual identifiers sent, from bench/results/multi-openai-*.jsonl:
   *   gdrive.sheets_append_rows   coding.task_result   reverse.geocode
   *   scorecard.lf_daily          get.label_data       order.path_financial
   *
   * Rejecting these cost six turns per task and more money than the smaller map
   * saved. The model's guess was reasonable; our lookup was too strict.
   */
  const c = () => compress(TOOLS, { level: 3, mapStyle: "grouped" });

  for (const sep of [".", ":", "/", "-", " ", ""]) {
    it(`accepts namespace${JSON.stringify(sep)}op`, () => {
      const r = c().resolve("t", {
        f: `github${sep}create_issue`,
        a: { owner: "acme", repo: "web", title: "x" },
      });
      expect(r.kind, `separator ${JSON.stringify(sep)}`).toBe("call");
      if (r.kind === "call") expect(r.name).toBe("github_create_issue");
    });
  }

  it("accepts a dotted name through q() as well as t()", () => {
    const r = c().resolve("q", { c: "github.create_issue" });
    expect(r.kind).toBe("meta");
  });

  it("is case-insensitive about it", () => {
    const r = c().resolve("t", {
      f: "GitHub.Create_Issue",
      a: { owner: "a", repo: "b", title: "c" },
    });
    expect(r.kind).toBe("call");
  });

  it("still rejects a genuinely unknown name, and names the near miss", () => {
    const r = c().resolve("t", { f: "github.delete_everything", a: {} });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/No map code|Did you mean/);
  });

  it("refuses to guess when two tools normalise identically", () => {
    // a_b and a.b both normalise to "ab": ambiguous, so neither is aliased.
    const clash = [
      { name: "a_b", description: "x", inputSchema: { type: "object", properties: {} } },
      { name: "a.b", description: "y", inputSchema: { type: "object", properties: {} } },
    ];
    const k = compress(clash as any, { level: 3, mapStyle: "nocode" });
    expect(k.resolve("t", { f: "ab", a: {} }).kind).toBe("error");
    // The exact names still work.
    expect(k.resolve("t", { f: "a_b", a: {} }).kind).toBe("call");
  });

  it("applies to the shipped default too, not just codeless styles", () => {
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", {
      f: "github.create_issue",
      a: { owner: "a", repo: "b", title: "c" },
    });
    expect(r.kind).toBe("call");
  });
});

describe("grouped: a name with no separator must not become a degenerate group", () => {
  /**
   * Found on the real 149-tool corpus. `customers`, `fifo` and `intransit` contain
   * no underscore, so defaultNamespaceOf sets ns === op === name. `grouped` then
   * rendered `customers: customers()` while the legend promised a tool's full name
   * is namespace_op — so a model following the documented rule builds
   * `customers_customers`, which does not exist. All three tools were unreachable
   * via the stated contract.
   *
   * A group of one is never worth factoring anyway: `customers: customers()` is
   * longer than `customers`.
   */
  const SINGLE: Tool[] = [
    { name: "fifo", description: "On-dock FIFO report.", inputSchema: { type: "object", properties: {} } },
    { name: "customers", description: "Customer accounts.", inputSchema: { type: "object", properties: {} } },
    { name: "github_create_issue", description: "Open an issue.", inputSchema: { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] } },
    { name: "github_search_issues", description: "Search issues.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  ];
  const c = () => compress(SINGLE, { level: 3, mapStyle: "grouped" });

  it("emits a separator-less name as a complete name, not `x: x()`", () => {
    const map = mapOf(c().systemPreamble);
    expect(map).not.toContain("fifo: fifo");
    expect(map).not.toContain("customers: customers");
    expect(map.split("\n")).toContain("fifo");
  });

  it("still resolves it by its real name", () => {
    for (const n of ["fifo", "customers"]) {
      const r = c().resolve("t", { f: n, a: {} });
      expect(r.kind, n).toBe("call");
      if (r.kind === "call") expect(r.name).toBe(n);
    }
  });

  it("still groups a namespace that has more than one tool", () => {
    expect(mapOf(c().systemPreamble)).toMatch(/^github: /m);
  });

  it("tells the model that a colonless line is already a full name", () => {
    expect(c().systemPreamble).toContain("no colon is already a complete tool name");
  });

  it("every tool in the real corpus resolves by its real name", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const k = compress(REAL_TOOLS as any, { level: 3, mapStyle: "grouped" });
    const unreachable = REAL_TOOLS.filter((t: any) => {
      const r = k.resolve("t", { f: t.name, a: {} });
      // A missing-required-argument error still means the tool was FOUND.
      return r.kind === "error" && !/Missing required/.test(r.message);
    });
    expect(unreachable.map((t: any) => t.name)).toEqual([]);
  });
});

describe("compact: same information, cheaper serialization", () => {
  /**
   * Measured with real tokenizers on the 149-tool real corpus, map block only:
   *
   *              Claude  GPT o200k  Gemini  Grok   chars
   *   default      2428       1331    1573  1564    5100
   *   compact      2078       1106    1312  1333    4958
   *
   * Two changes, both information-preserving:
   *   1. space instead of comma between required args — measured -80 Claude tokens
   *      at IDENTICAL character count, which is why this study used tokens.
   *   2. flat two-letter code instead of the namespace-prefixed `a0`, whose
   *      namespace was already redundant with the name on the same line.
   *
   * Base36 codes scored the same and are BROKEN: (26).toString(36) === "q" and
   * (29).toString(36) === "t" collide with the dispatcher tool names, making those
   * tools unreachable via resolve()'s bare-code path.
   */
  const c = () => compress(TOOLS, { level: 3, mapStyle: "compact" });

  it("separates required args with a space, not a comma", () => {
    const map = mapOf(c().systemPreamble);
    expect(map).toContain("github_create_issue owner repo title");
    expect(map).not.toContain("owner,repo,title");
  });

  it("uses flat two-letter codes", () => {
    for (const t of TOOLS) expect(c().codeFor(t.name)).toMatch(/^[a-z]{2}$/);
  });

  it("never issues a code colliding with the t or q dispatchers", () => {
    // The base36 trap. Check a corpus large enough to reach index 26 and 29.
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `svc_op${i}`,
      description: "d",
      inputSchema: { type: "object", properties: {} },
    }));
    const k = compress(many as any, { level: 3, mapStyle: "compact" });
    const codes = many.map((t) => k.codeFor(t.name));
    expect(codes).not.toContain("t");
    expect(codes).not.toContain("q");
    expect(new Set(codes).size).toBe(many.length);
  });

  it("carries the same information as the default it replaces", () => {
    const a = compress(TOOLS, { level: 3, mapStyle: "name+required" });
    const b = c();
    // Same tools, same required args, only the serialization differs.
    for (const t of TOOLS) {
      const req = (t.inputSchema as any).required ?? [];
      const line = mapOf(b.systemPreamble).split("\n").find((l) => l.includes(t.name))!;
      for (const r of req) expect(line, t.name).toContain(r);
    }
    // Character count is IDENTICAL: comma->space is one char for one char, and
    // `aa` is as long as `a0`. That is the point of this style, and the reason it
    // was found by measuring tokens rather than bytes — a character-based metric
    // reports this change as worth exactly nothing.
    expect(mapOf(b.systemPreamble).length).toBe(mapOf(a.systemPreamble).length);
  });

  it("round-trips by code and by real name", () => {
    const k = c();
    for (const t of TOOLS) {
      expect(k.resolve("t", { f: k.codeFor(t.name), a: {} }).kind).not.toBe("meta");
      const byName = k.resolve("t", { f: t.name, a: {} });
      if (byName.kind === "error") expect(byName.message).toMatch(/Missing required/);
    }
  });

  it("resolves every tool in the real corpus, by code and by name", async () => {
    const { REAL_TOOLS } = await import("../bench/fixtures/real.js");
    const k = compress(REAL_TOOLS as any, { level: 3, mapStyle: "compact" });
    const found = (r: any) => r.kind === "call" || /Missing required/.test(r.message ?? "");
    const bad = REAL_TOOLS.filter(
      (t: any) =>
        !found(k.resolve("t", { f: k.codeFor(t.name), a: {} })) ||
        !found(k.resolve("t", { f: t.name, a: {} })),
    );
    expect(bad.map((t: any) => t.name)).toEqual([]);
  });
});

describe("observed on grok-4.5: the lookup tool routed through the dispatcher", () => {
  /**
   * Every malformed-argument event in the tier-1 real-tool run was this, across all
   * four level-3 styles including the shipped default:
   *
   *   t(f="q", a={s: "lost freight"})              instead of q(s="lost freight")
   *   t(f="q", a={c: "scorecard_lf_daily"})        instead of q(c="…")
   *   t(f="q", a={c: "scorecard:edemand_detail"})  ditto, with a colon
   *
   * The preamble invites it: "Invoke with t(f=<name>, a={…})" followed by "Use q to
   * expand a name" reads as "everything goes through t, including q". Every task
   * still succeeded, but each rejection burned a turn — and on a reasoning model a
   * turn is a fresh round of thinking.
   *
   * `t` and `q` are the library's own reserved names, so the intent is unambiguous.
   */
  const STYLES = ["name+required", "nocode", "grouped", "compact"] as const;

  for (const mapStyle of STYLES) {
    it(`${mapStyle}: accepts t(f="q") as a search`, () => {
      const k = compress(TOOLS, { level: 3, mapStyle });
      const r = k.resolve("t", { f: "q", a: { s: "issues" } });
      expect(r.kind).toBe("meta");
    });

    it(`${mapStyle}: accepts t(f="q") as an expand`, () => {
      const k = compress(TOOLS, { level: 3, mapStyle });
      const r = k.resolve("t", { f: "q", a: { c: k.codeFor("github_create_issue") } });
      expect(r.kind).toBe("meta");
      if (r.kind === "meta") expect(r.result).toContain("github_create_issue");
    });
  }

  it("accepts the lookup args passed flat rather than nested under a", () => {
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", { f: "q", s: "issues" } as any);
    expect(r.kind).toBe("meta");
  });

  it("unwraps a dispatcher nested inside itself", () => {
    // t(f="t", a={f:<code>, a:{…}}) — same confusion, one level deeper.
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", {
      f: "t",
      a: { f: k.codeFor("github_search_issues"), a: { q: "leak" } },
    });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("github_search_issues");
  });

  it("does not break a real tool that legitimately resolves", () => {
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", { f: k.codeFor("github_create_issue"), a: { owner: "a", repo: "b", title: "c" } });
    expect(r.kind).toBe("call");
  });

  it("still rejects a tool genuinely named neither t nor q", () => {
    const k = compress(TOOLS, { level: 3 });
    expect(k.resolve("t", { f: "zzz_not_a_tool", a: {} }).kind).toBe("error");
  });
});
