/**
 * Compilation is bring-your-own-model, and the library's job is the safety check.
 *
 * Every test here uses a fake `complete`, so the suite stays offline and the verification
 * logic — the part that decides whether a model's output is safe to ship — is exercised
 * against outputs a real model actually produces, including the bad ones.
 *
 * The stakes: a compiled map that renames a tool or invents a parameter is worse than no
 * map. The model would call something that does not exist, and it would surface as a wrong
 * dispatch rather than an error.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compileTools, compress, verifyCompiledLine, COMPILE_SYSTEM_PROMPT } from "../src/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description: "Create a new issue in a repository. Use for bugs and feature requests.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
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

const good = {
  github_create_issue: `def github_create_issue(owner,repo,title,body=0):"file bug/feature on repo"`,
  slack_post_message: `def slack_post_message(channel,text):"post to channel; not for DMs"`,
};
const replying = (lines: string[]) => async () => lines.join("\n");

describe("verifyCompiledLine refuses anything that misrepresents the tool", () => {
  const t = TOOLS[0];
  const cases: [string, string, RegExp | null][] = [
    ["a correct line", good.github_create_issue, null],
    ["a renamed tool", `def gh_issue(owner,repo,title):"x"`, /renamed/],
    ["an invented parameter", `def github_create_issue(owner,repo,title,assignee=0):"x"`, /invented parameter\(s\): assignee/],
    ["a dropped required parameter", `def github_create_issue(owner,repo):"x"`, /dropped required parameter\(s\): title/],
    ["prose instead of a def", `This tool files an issue.`, /not a single-line def/],
    ["a body that is not a docstring", `def github_create_issue(owner,repo,title): pass`, /docstring/],
  ];
  for (const [label, line, expected] of cases) {
    it(label, () => {
      const r = verifyCompiledLine(line, t);
      if (expected === null) expect(r).toBeNull();
      else expect(r).toMatch(expected);
    });
  }

  it("accepts optional parameters in any order but requires every required one", () => {
    expect(verifyCompiledLine(`def github_create_issue(title,owner,repo,body=0):"x"`, t)).toBeNull();
  });
});

describe("the optional-parameter convention, which live testing corrected", () => {
  /**
   * The first compiled corpus wrote optional parameters as `name=0`. Every provider read
   * that as a type declaration rather than a marker for "optional": three of four sent
   * `latest_snapshot_only: 1` for a boolean and were rejected by validation — a 3-in-8
   * malformed-argument rate, identical failure, independently arrived at.
   *
   * `=None` is the idiomatic Python sentinel and implies no type. Re-running the same
   * eight live calls after the change took malformed arguments to zero.
   *
   * Offline metrics — size, ambiguity — could not have caught this. It is pinned here
   * because it is a one-word detail in a prompt with an outsized effect.
   */
  it("the prompt asks for =None and explicitly forbids =0", () => {
    const prompt = COMPILE_SYSTEM_PROMPT(110);
    expect(prompt).toContain("name=None");
    expect(prompt).toMatch(/never 0/);
    expect(prompt, "the worked example must not contradict the rule").not.toMatch(/=0[,)]/);
  });

  it("the committed corpus map uses no numeric defaults", () => {
    const map: Record<string, string> = JSON.parse(
      readFileSync("bench/fixtures/python-map.json", "utf8"),
    );
    const offenders = Object.entries(map).filter(([, line]) => /=0[,)]/.test(line));
    expect(offenders.map(([n]) => n), "a numeric default reads as a type").toEqual([]);
    expect(Object.keys(map).length).toBeGreaterThan(100);
  });
});

describe("compileTools", () => {
  it("returns a map keyed by real tool name", async () => {
    const r = await compileTools(TOOLS, { complete: replying(Object.values(good)) });
    expect(Object.keys(r.compiled).sort()).toEqual(["github_create_issue", "slack_post_message"]);
    expect(r.rejected).toEqual([]);
    expect(r.stats.compiled).toBe(2);
  });

  it("never imports a client — the caller supplies one", async () => {
    // The zero-dependency guarantee in one assertion: without a `complete` there is no
    // way for this function to reach a model.
    await expect(compileTools(TOOLS, {} as any)).rejects.toThrow(/bring your own model/);
  });

  it("discards a line that fails verification rather than shipping it", async () => {
    const bad = [`def github_create_issue(owner,repo,title,assignee=0):"x"`, good.slack_post_message];
    const r = await compileTools(TOOLS, { complete: replying(bad), retryFailures: false });
    expect(r.compiled.github_create_issue).toBeUndefined();
    expect(r.compiled.slack_post_message).toBeDefined();
    expect(r.rejected).toEqual([{ name: "github_create_issue", reason: "invented parameter(s): assignee" }]);
  });

  it("retries a failure individually, and keeps the retry when it is correct", async () => {
    let call = 0;
    const complete = async () => {
      call++;
      // First call is the batch and gets one wrong; the retry returns a good line.
      return call === 1
        ? [`def github_create_issue(owner):"x"`, good.slack_post_message].join("\n")
        : good.github_create_issue;
    };
    const r = await compileTools(TOOLS, { complete });
    expect(call, "batch, then one retry").toBe(2);
    expect(r.compiled.github_create_issue).toBe(good.github_create_issue);
    expect(r.rejected).toEqual([]);
  });

  it("reports a tool the model never mentioned", async () => {
    const r = await compileTools(TOOLS, { complete: replying([good.slack_post_message]), retryFailures: false });
    expect(r.rejected).toEqual([{ name: "github_create_issue", reason: "no line returned" }]);
  });

  it("passes the real contract to the model, not just the prose", async () => {
    let seen = "";
    await compileTools(TOOLS, {
      complete: async ({ user }) => { seen = user; return Object.values(good).join("\n"); },
    });
    // Required marked, optional unmarked — the model cannot honour a contract it is not shown.
    expect(seen).toContain("owner*");
    expect(seen).toMatch(/,\s*body\b/);  // optional: named, unmarked
    expect(seen).toContain("Use for bugs and feature requests.");
  });

  it("batches, so a large corpus is not one enormous request", async () => {
    const many: Tool[] = Array.from({ length: 30 }, (_, i) => ({
      name: `svc_op${i}`, description: "d",
      inputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    }));
    let calls = 0;
    await compileTools(many, {
      batchSize: 10,
      retryFailures: false,
      complete: async ({ user }) => {
        calls++;
        return user.split("\n\n").map((l) => `def ${l.split(" — ")[0]}(a):"d"`).join("\n");
      },
    });
    expect(calls).toBe(3);
  });
});

describe("staleness, partial maps and dangling references", () => {
  /**
   * The three things standing between level 4 and a merge, each closed by a mechanism
   * rather than a promise to remember.
   */
  const tools: Tool[] = [
    { name: "article_append", description: "Add to end.", inputSchema: { type: "object", properties: { article_id: { type: "number" }, content: { type: "string" } }, required: ["article_id", "content"] } },
    { name: "article_update", description: "Replace.", inputSchema: { type: "object", properties: { article_id: { type: "number" }, content: { type: "string" } }, required: ["article_id", "content"] } },
  ];
  const compiled = {
    article_append: `def article_append(article_id,content):"add to end; use over article_update"`,
    article_update: `def article_update(article_id,content):"overwrite; use article_append to add"`,
  };
  /** The same corpus after `article_append` gains a required parameter. */
  const moved = (): Tool[] => {
    const next = JSON.parse(JSON.stringify(tools));
    next[0].inputSchema.properties.section_title = { type: "string" };
    next[0].inputSchema.required = ["article_id", "section_title", "content"];
    return next;
  };

  it("a fresh map reports no staleness", () => {
    const s = compress(tools, { level: 4, compiled }).stats;
    expect(s.staleCompiledTools).toEqual([]);
    expect(s.uncompiledTools).toBe(0);
    expect(s.orphanedCompiledEntries).toBe(0);
  });

  it("detects a line that no longer matches its schema, without any fingerprint", () => {
    // The schema is the fingerprint: re-verifying at the point of use catches drift that
    // a stored hash would only catch if someone remembered to store one.
    const s = compress(moved(), { level: 4, compiled }).stats;
    expect(s.staleCompiledTools).toEqual(["article_append: dropped required parameter(s): section_title"]);
  });

  it("drops the stale line rather than showing the model parameters that no longer exist", () => {
    const c = compress(moved(), { level: 4, compiled });
    const line = c.systemPreamble.split("\n").find((l) => l.includes("article_append"))!;
    expect(line, "must show the new required parameter").toContain("section_title");
    expect(line).toContain("(not compiled)");
    expect(c.stats.uncompiledTools).toBe(1);
  });

  it("counts compiled entries for tools that no longer exist", () => {
    const s = compress(tools, {
      level: 4,
      compiled: { ...compiled, deleted_tool: `def deleted_tool(a):"gone"` },
    }).stats;
    expect(s.orphanedCompiledEntries).toBe(1);
  });

  it("requireCompiled turns a partial map into a failure, and names the cause", () => {
    expect(() => compress(moved(), { level: 4, compiled, requireCompiled: true }))
      .toThrow(/1 of 2 tools have no usable compiled line/);
    expect(() => compress(moved(), { level: 4, compiled, requireCompiled: true }))
      .toThrow(/section_title/);
  });

  it("requireCompiled is off by default, because degrading beats failing at runtime", () => {
    expect(() => compress(moved(), { level: 4, compiled })).not.toThrow();
  });

  it("flags a docstring that redirects to a tool not in the corpus", async () => {
    // The leak found by compiling a deliberately-wrong corpus: a description said
    // "use compress_output first" and the compiler faithfully carried it, to a tool that
    // does not exist. Verification covers the contract; this covers the claim's target.
    const withRedirect = {
      article_append: `def article_append(article_id,content):"add to end; call compress_output first if large"`,
      article_update: compiled.article_update,
    };
    const r = await compileTools(tools, {
      complete: async ({ user }) =>
        user.split("\n\n").map((l) => withRedirect[l.split(" — ")[0] as keyof typeof withRedirect]).filter(Boolean).join("\n"),
    });
    expect(r.danglingReferences).toEqual([{ name: "article_append", mentions: "compress_output" }]);
  });

  it("does not flag a redirect to a tool that does exist", async () => {
    const r = await compileTools(tools, {
      complete: async ({ user }) =>
        user.split("\n\n").map((l) => compiled[l.split(" — ")[0] as keyof typeof compiled]).filter(Boolean).join("\n"),
    });
    expect(r.danglingReferences).toEqual([]);
  });
});

/**
 * A batch shows the model 12 tools out of 149 while the prompt asks each docstring to say
 * when to reach for this tool instead of a similar one. That is an invitation to name a
 * sibling from memory, and on the real corpus it accepted the invitation: `get_place_details`
 * compiled to "…use place_details_by_query if only name/address", and no such tool exists.
 * The one it meant, `search_places`, was in the corpus all along.
 *
 * `danglingReferences` caught it and it was shipped anyway, so the fix is at the cause: send
 * every batch the full roster of real names. Recompiling with it took the corpus from two
 * dangling references to zero, and rewrote both lines to name the real tool or name nothing.
 */
describe("the compiling model is given the real tool inventory", () => {
  const seen: string[] = [];
  const fake = async ({ user }: { system: string; user: string }) => {
    seen.push(user);
    const names = [...user.matchAll(/^(\w+) — /gm)].map((m) => m[1]);
    return names.map((n) => `def ${n}():"does a thing"`).join("\n");
  };

  it("sends every tool name with every batch, not just the batch's own", async () => {
    seen.length = 0;
    const many: Tool[] = Array.from({ length: 30 }, (_, i) => ({
      name: `tool_${i}`,
      description: "Does a thing.",
      input_schema: { type: "object", properties: {} },
    })) as Tool[];

    await compileTools(many, { complete: fake, batchSize: 12 });

    expect(seen.length).toBeGreaterThan(1);
    for (const user of seen) {
      // A batch of 12 still learns about all 30.
      for (const t of many) expect(user).toContain(t.name);
      expect(user).toMatch(/MUST appear here/);
    }
  });

  it("tells the model, in the system prompt, not to name a tool outside it", () => {
    expect(COMPILE_SYSTEM_PROMPT(110)).toMatch(/Never name a tool that is not in the inventory/);
  });

  it("ships a corpus map with no dangling references", () => {
    // The end state, asserted on the artifact itself: no docstring points at a tool the
    // corpus does not contain. This is what was wrong with the map 0.6.1 published.
    const raw = JSON.parse(readFileSync("bench/fixtures/real-mcp-tools.json", "utf8"));
    const tools: Tool[] = Array.isArray(raw) ? raw : raw.tools;
    const map = JSON.parse(readFileSync("bench/fixtures/python-map.json", "utf8"));
    const compiled: Record<string, string> = map.compiled ?? map;
    const known = new Set(tools.map((t) => t.name));

    const dangling: string[] = [];
    for (const [name, line] of Object.entries(compiled)) {
      const doc = line.slice(line.indexOf('):"') + 3, -1);
      for (const m of doc.matchAll(/(?:use|instead of|before|via)\s+([a-z][a-z0-9]*(?:_[a-z0-9]+)+)/g)) {
        if (!known.has(m[1])) dangling.push(`${name} → ${m[1]}`);
      }
    }
    expect(dangling, `map points at tools that do not exist:\n  ${dangling.join("\n  ")}`).toEqual([]);
  });
});
