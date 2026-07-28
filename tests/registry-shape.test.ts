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
import { compileTools, compress } from "../src/index.js";
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

describe("level 4 speaks function names everywhere, not codes", () => {
  /**
   * Level 4's map contains no codes, so every surface that mentions one is an invitation
   * to invent one. grok-4.5 did exactly that in the 144-run sweep — `q(c="a2")`, twice —
   * because `t` and `q` still described themselves in terms of "map codes".
   *
   * The dispatcher wording was fixed first; these cover the rest of the surface, including
   * the search results, which were still answering in codes the model had never seen.
   */
  const tools: Tool[] = [
    { name: "github_create_issue", description: "File a bug.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
    { name: "sentry_list_issues", description: "List errors.", inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } },
  ];
  const compiled = {
    github_create_issue: `def github_create_issue(owner,repo):"file bug on repo"`,
    sentry_list_issues: `def sentry_list_issues(project):"unresolved errors, most frequent first"`,
  };
  const c = () => compress(tools, { level: 4, compiled });

  it("the dispatcher tells the model to use function names", () => {
    const wire = c().tools as any[];
    expect(wire.find((t) => t.name === "t").description).toMatch(/function name/);
    expect(wire.find((t) => t.name === "t").description).not.toMatch(/map code/);
    expect(wire.find((t) => t.name === "q").description).toMatch(/function name/);
  });

  it("an unknown target is reported as a missing function, not a missing code", () => {
    const r = c().resolve("t", { f: "zz9", a: {} });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/No function named "zz9"/);
      expect(r.message).not.toMatch(/map code/);
    }
  });

  it("a keyword search answers with compiled declarations, not codes", () => {
    const r = c().resolve("q", { s: "bug" });
    expect(r.kind).toBe("meta");
    if (r.kind === "meta") {
      expect(r.result).toContain("def github_create_issue(owner,repo)");
      // A code-shaped prefix like `a0 = ` would hand the model a handle it never saw.
      expect(r.result).not.toMatch(/^[a-z]+\d+\s*=/m);
    }
  });

  it("expanding one function returns its declaration plus the full description", () => {
    const r = c().resolve("q", { c: "sentry_list_issues" });
    expect(r.kind).toBe("meta");
    if (r.kind === "meta") {
      expect(r.result).toContain("def sentry_list_issues(project)");
      expect(r.result).toContain("List errors.");
    }
  });

  it("level 3 still speaks codes — none of this leaked downward", () => {
    const three = compress(tools, { level: 3 });
    expect((three.tools as any[]).find((t) => t.name === "t").description).toMatch(/map code/);
    const r = three.resolve("q", { s: "bug" });
    if (r.kind === "meta") expect(r.result).toMatch(/^[a-z]+\d+\s*=/m);
  });
});

describe("compiled descriptions at level 1, and name enforcement on the dispatcher", () => {
  /**
   * Both came out of one question: could level 4 have provider-side enforcement?
   *
   * Argument enforcement: no, and not for cost reasons. It would need a discriminated
   * union on `f`, and the Anthropic API rejects oneOf/allOf/anyOf at the top level of an
   * input_schema outright. Measured anyway at +112,488 characters — more than level 1.
   *
   * What is available is narrower and more useful than expected.
   */
  const tools: Tool[] = [
    { name: "article_update", description: "Replace the entire body of an existing article with new content, discarding what was there.", inputSchema: { type: "object", properties: { article_id: { type: "number" }, content: { type: "string" } }, required: ["article_id", "content"] } },
    { name: "article_append", description: "Append content to an article without replacing what is already there.", inputSchema: { type: "object", properties: { article_id: { type: "number" }, content: { type: "string" } }, required: ["article_id", "content"] } },
  ];
  const compiled = {
    article_update: `def article_update(article_id,content):"overwrite whole body; use article_append to add"`,
    article_append: `def article_append(article_id,content):"add to end; use over article_update"`,
  };

  it("level 1 keeps BOTH the parameter inventory and the compiled docstring", () => {
    /**
     * This assertion is the reverse of what it was in 0.5.0, and the reversal is the point.
     *
     * The original shipped the docstring alone, which saved 16% — until an external team
     * measured what that costs. Level 1 strips every per-property `description`, so the
     * signature line is the only place the parameter inventory appears in prose. Removing
     * it took their selection accuracy from 68.9% to 60.0% on Opus and 57.8% to 44.4% on
     * Kimi, and made a previously clean arm invent parameters that exist on no tool.
     */
    const t = (compress(tools, { level: 1, compiled }).tools as any[]).find((w) => w.name === "article_append");
    expect(t.description, "the interface statement").toMatch(/^article_append\(/);
    expect(t.description, "the purpose statement").toContain("add to end; use over article_update");
    // Enforcement is the other half, and it never moved.
    expect(t.input_schema.properties).toHaveProperty("content");
    expect(t.input_schema.required).toEqual(["article_id", "content"]);
  });

  it("the saving is available, but only by dropping the inventory", () => {
    /**
     * The invariant, stated at the right level of generality. A first draft asserted that
     * keeping the prefix costs at least as much as plain level 1 — true on the real corpus
     * (+2.2%) and false here, because these two fixtures have compiled docstrings shorter
     * than their own descriptions. Whether compiled beats plain depends on your prose;
     * whether dropping the prefix removes the parameter inventory does not.
     */
    const kept = compress(tools, { level: 1, compiled }).stats.compressedChars;
    const dropped = compress(tools, { level: 1, compiled, signaturePrefix: false }).stats.compressedChars;
    expect(dropped, "the saving comes from removing the signature").toBeLessThan(kept);

    const withPrefix = (compress(tools, { level: 1, compiled }).tools as any[])[0].description;
    const without = (compress(tools, { level: 1, compiled, signaturePrefix: false }).tools as any[])[0].description;
    expect(withPrefix).toMatch(/^article_\w+\(/);
    expect(without, "and what it removes is the only prose statement of the interface")
      .not.toMatch(/^article_\w+\(/);
  });

  it("reports a compiled signature that omits parameters the tool has", async () => {
    // verifyCompiledLine refuses an INVENTED parameter and a dropped REQUIRED one, but
    // permits dropping optional ones — so a line describing one of seven parameters passes
    // and still under-describes. Zero on our corpus; nothing was enforcing it.
    // Must be an OPTIONAL parameter: dropping a required one is already refused outright,
    // which is exactly why the gap existed — the permitted case was the unchecked one.
    const withOptional: Tool[] = [{
      name: "kb_search",
      description: "Search the knowledge base.",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" }, limit: { type: "integer" }, status: { type: "string" } },
        required: ["q"],
      },
    }];
    const r = await compileTools(withOptional, {
      complete: async () => `def kb_search(q):"find articles by query"`,
    });
    expect(r.rejected, "dropping optional parameters is permitted").toEqual([]);
    expect(r.incompleteSignatures).toEqual([{ name: "kb_search", omitted: "limit, status" }]);
  });

  it("falls back to the tool's own prose when a compiled line is stale", () => {
    const moved: Tool[] = JSON.parse(JSON.stringify(tools));
    (moved[1].inputSchema as any).properties.section = { type: "string" };
    (moved[1].inputSchema as any).required = ["article_id", "section", "content"];
    const t = (compress(moved, { level: 1, compiled }).tools as any[]).find((w) => w.name === "article_append");
    expect(t.description, "a stale docstring must not describe parameters that changed")
      .toContain("Append content to an article");
  });

  it("leaves level 1 byte-identical when no map is supplied", () => {
    const before = compress(tools, { level: 1 });
    expect(before.stats.compressedChars).toBe(compress(tools, { level: 1, compiled: {} }).stats.compressedChars);
  });

  it("the dispatcher's f stays unconstrained — an enum here was measured and removed", () => {
    // +47% to +70% of the level-3 map, zero hallucinated names prevented in 192 runs, and
    // it caused grok-4.5 to answer with no tool call and no error twice. RESULTS Round 10.
    for (const opts of [{ level: 3 as const }, { level: 4 as const, compiled }]) {
      expect((compress(tools, opts).tools as any[])[0].input_schema.properties.f).toEqual({ type: "string" });
    }
  });
});
