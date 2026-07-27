/**
 * Two features that came out of one external report.
 *
 * A team ran toolgz against a live 60-tool registry and hit a level-3 regression: 19 of
 * their tools are named `manage_*` and 15 take a single required `operation`, so the
 * `<toolmap>` rendered 44 of 60 lines into lookalike groups — the largest with 24
 * members, all reading `manage_x operation`. Asked to attach a note to "table tbl_ord",
 * the model keyword-matched "table" to `manage_table` 3 times out of 3. Nothing was
 * wrong with the model; the map had deleted every other signal.
 *
 * They found it by spending $25 on a live sweep. It is computable offline in
 * milliseconds, which is what `ambiguousMapLines` is for.
 *
 * The second feature is the fix for the other half of their report: their confirmation
 * contract lived in description prose, which every level above 0 strips.
 */
import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

/** Their shape: compound tools, one required `operation`, names the only discriminator. */
const manageStyle = (n: number): Tool[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `manage_${["table", "rows", "memories", "entity_intel", "dashboard"][i % 5]}${i}`,
    description: `Manage ${i}.`,
    inputSchema: {
      type: "object",
      properties: { operation: { type: "string", enum: ["list", "create", "delete"] } },
      required: ["operation"],
    },
  }));

const distinct: Tool[] = [
  { name: "github_create_issue", description: "x", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
  { name: "slack_post_message", description: "y", inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] } },
  { name: "sentry_list_issues", description: "z", inputSchema: { type: "object", properties: { project: { type: "string" }, env: { type: "string" } }, required: ["project"] } },
];

describe("ambiguousMapLines tells you the map carries nothing but names", () => {
  it("counts every line sharing a body, and the largest group", () => {
    const s = compress(manageStyle(15), { level: 3 }).stats;
    expect(s.ambiguousMapLines).toBe(15);
    expect(s.largestLookalikeGroup).toBe(15);
  });

  it("reports zero and a group of one when every line is distinct", () => {
    const s = compress(distinct, { level: 3 }).stats;
    expect(s.ambiguousMapLines).toBe(0);
    expect(s.largestLookalikeGroup, "1 means no line shares a body").toBe(1);
  });

  it("is absent below level 3, which has no map", () => {
    for (const level of [0, 1, 2] as const) {
      expect(compress(distinct, { level }).stats.ambiguousMapLines).toBeUndefined();
      expect(compress(distinct, { level }).stats.largestLookalikeGroup).toBeUndefined();
    }
  });

  it("drops when a richer map style adds a discriminator", () => {
    // The reported fix. On their real registry this went 44/60 to 2/60; here the tools
    // differ in their enum values, which `signature` surfaces and `name+required` hides.
    const varied: Tool[] = ["delete_table", "add_column", "drop_view"].map((op, i) => ({
      name: `manage_thing${i}`,
      description: "d",
      inputSchema: {
        type: "object",
        properties: { operation: { type: "string", enum: [op, "list"] } },
        required: ["operation"],
      },
    }));
    expect(compress(varied, { level: 3, mapStyle: "name+required" }).stats.ambiguousMapLines).toBe(3);
    expect(compress(varied, { level: 3, mapStyle: "signature" }).stats.ambiguousMapLines).toBe(0);
  });

  it("is derived from what is rendered, not from parsing it back", () => {
    // Cross-check against the emitted map so the number cannot describe a different map.
    const c = compress(manageStyle(9), { level: 3 });
    const lines = c.systemPreamble.split("\n").filter((l) => /^[a-z]+\d+\s/.test(l));
    const bodies = lines.map((l) => l.split(" ").slice(2).join(" "));
    const counts = new Map<string, number>();
    for (const b of bodies) counts.set(b, (counts.get(b) ?? 0) + 1);
    const sizes = [...counts.values()].filter((n) => n > 1);
    expect(c.stats.ambiguousMapLines).toBe(sizes.reduce((a, b) => a + b, 0));
    expect(c.stats.largestLookalikeGroup).toBe(Math.max(...sizes));
  });
});

describe("conditionally required parameters are enforced", () => {
  /**
   * The shape that solves a compound tool's confirmation gate. `_confirmed` cannot go in
   * `required[]` — that would break `{operation:"list"}` — so the requirement is
   * conditional on the operation.
   */
  const gated: Tool[] = [
    {
      name: "manage_dashboard",
      description: "Manage dashboards.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["list", "get", "delete", "purge"] },
          id: { type: "string" },
          _confirmed: { type: "boolean" },
        },
        required: ["operation"],
        allOf: [
          { if: { properties: { operation: { const: "delete" } } }, then: { required: ["_confirmed"] } },
          { if: { properties: { operation: { enum: ["purge"] } } }, then: { required: ["_confirmed", "id"] } },
        ],
      },
    },
  ];
  const call = (args: Record<string, any>) => {
    const c = compress(gated, { level: 3 });
    return c.resolve("t", { f: c.codeFor("manage_dashboard"), a: args });
  };

  it("lets a benign operation through", () => {
    expect(call({ operation: "list" }).kind).toBe("call");
    expect(call({ operation: "get", id: "d1" }).kind).toBe("call");
  });

  it("refuses the gated operation without the flag, and says which", () => {
    const r = call({ operation: "delete", id: "d1" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("_confirmed");
      expect(r.recoverable, "the model should retry with the flag").toBe(true);
    }
  });

  it("accepts the gated operation once the flag is present", () => {
    expect(call({ operation: "delete", id: "d1", _confirmed: true }).kind).toBe("call");
  });

  it("honours an enum condition and multiple required keys", () => {
    expect(call({ operation: "purge", _confirmed: true }).kind).toBe("error"); // id missing
    expect(call({ operation: "purge", id: "d1" }).kind).toBe("error");         // flag missing
    expect(call({ operation: "purge", id: "d1", _confirmed: true }).kind).toBe("call");
  });

  it("works at every level, because it is our validation and not the provider's", () => {
    for (const level of [0, 1, 2, 3] as const) {
      const c = compress(gated, { level });
      const raw = c.encodeCallForTest("manage_dashboard", { operation: "delete", id: "d1" });
      expect(c.resolve(raw.name, raw.args).kind, `level ${level}`).toBe("error");
    }
  });

  it("does not treat a condition it cannot evaluate as satisfied", () => {
    // Guarding against the dangerous failure direction: an unsupported condition must
    // never silently add a requirement, which would reject valid calls.
    const weird: Tool[] = [{
      name: "svc_do", description: "d",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string" }, flag: { type: "boolean" } },
        required: ["mode"],
        allOf: [{ if: { properties: { mode: { pattern: "^danger" } } }, then: { required: ["flag"] } }],
      },
    }];
    const c = compress(weird, { level: 3 });
    expect(c.resolve("t", { f: c.codeFor("svc_do"), a: { mode: "danger-zone" } }).kind).toBe("call");
  });

  it("ignores an unsupported branch rather than half-honouring it", () => {
    const withElse: Tool[] = [{
      name: "svc_x", description: "d",
      inputSchema: {
        type: "object",
        properties: { op: { type: "string" }, a: { type: "string" } },
        required: ["op"],
        if: { properties: { op: { const: "go" } } },
        then: { required: ["a"] },
        else: { required: ["a"] },
      },
    }];
    const c = compress(withElse, { level: 3 });
    const code = c.codeFor("svc_x");
    expect(c.resolve("t", { f: code, a: { op: "go" } }).kind, "then is honoured").toBe("error");
    expect(c.resolve("t", { f: code, a: { op: "stop" } }).kind, "else is ignored").toBe("call");
  });
});

describe("level 4 — a map a model compiled for you", () => {
  /**
   * Level 4 is level 3 with the mechanical map replaced by one a model wrote, so the map
   * can carry what a tool is FOR. Everything else — code assignment, the resolver, the
   * name index, validation — is shared.
   */
  const tools: Tool[] = [
    { name: "article_update", description: "Replace the whole body.", inputSchema: { type: "object", properties: { article_id: { type: "number" }, content: { type: "string" } }, required: ["article_id", "content"] } },
    { name: "article_append", description: "Add to the end.", inputSchema: { type: "object", properties: { article_id: { type: "number" }, content: { type: "string" } }, required: ["article_id", "content"] } },
  ];
  const compiled = {
    article_update: `def article_update(article_id,content):"overwrite whole body, old text lost; use article_append to add"`,
    article_append: `def article_append(article_id,content):"add to end, keeping existing text; use over article_update"`,
  };

  it("refuses to run without a compiled map, and says how to get one", () => {
    // The alternative is a silently empty map, which is the worst possible failure.
    expect(() => compress(tools, { level: 4 })).toThrow(/needs a compiled map/);
    expect(() => compress(tools, { level: 4 })).toThrow(/npx toolgz compile/);
  });

  it("puts the compiled lines in the system prompt and two tools on the wire", () => {
    const c = compress(tools, { level: 4, compiled });
    expect(c.stats.wireToolCount).toBe(2);
    expect(c.systemPreamble).toContain("use article_append to add");
    expect(c.systemPreamble).toContain("```python");
  });

  it("disambiguates a pair that level 3 renders identically", () => {
    // Both tools take exactly the same required arguments, so name+required emits two
    // lines distinguishable only by name. This is the failure level 4 exists for.
    expect(compress(tools, { level: 3 }).stats.ambiguousMapLines).toBe(2);
    expect(compress(tools, { level: 4, compiled }).stats.ambiguousMapLines).toBe(0);
  });

  it("resolves a call made by real function name", () => {
    const c = compress(tools, { level: 4, compiled });
    const r = c.resolve("t", { f: "article_append", a: { article_id: 1, content: "x" } });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("article_append");
  });

  it("still validates arguments against the original schema", () => {
    const c = compress(tools, { level: 4, compiled });
    const r = c.resolve("t", { f: "article_append", a: { article_id: 1 } });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("content");
  });

  it("degrades rather than breaks when the map is partial", () => {
    const partial = { article_update: compiled.article_update };
    const c = compress(tools, { level: 4, compiled: partial });
    expect(c.stats.uncompiledTools, "the gap must be visible, not silent").toBe(1);
    // The uncompiled tool is still callable — it just has no written hint.
    expect(c.resolve("t", { f: "article_append", a: { article_id: 1, content: "x" } }).kind).toBe("call");
  });

  it("reports uncompiledTools only at level 4", () => {
    expect(compress(tools, { level: 3 }).stats.uncompiledTools).toBeUndefined();
    expect(compress(tools, { level: 4, compiled }).stats.uncompiledTools).toBe(0);
  });
});
