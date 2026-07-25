/**
 * Robustness of the level-3 resolver against how models actually call it.
 *
 * Every case here was observed in a real benchmark run, not imagined. Each one
 * previously cost a wasted turn — which is also a cost problem, since on a
 * reasoning model every retry pays for a fresh round of thinking.
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
      properties: {
        q: { type: "string", description: "The search query." },
        sort: { type: "string", enum: ["comments", "created", "updated"] },
        per_page: { type: "integer", description: "Results per page." },
      },
      required: ["q"],
    },
  },
  {
    name: "github_create_review",
    description: "Create a review on a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pull_number: { type: "integer" },
        event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
        body: { type: "string" },
      },
      required: ["owner", "repo", "pull_number", "event"],
    },
  },
];

const c = () => compress(TOOLS, { level: 3 });

describe("observed: model calls the map code as the tool name", () => {
  // Seen on claude-opus-5: name="b5", args={f:"b5", a:"{...}"} instead of
  // name="t". Codes are unique and cannot collide with `t`/`q`, so accepting
  // this form is unambiguous — there is nothing else it could mean.
  it("accepts a bare code as the tool name", () => {
    const k = c();
    const code = k.codeFor("github_search_issues");
    const r = k.resolve(code, { q: "memory leak" });
    expect(r.kind).toBe("call");
    if (r.kind === "call") {
      expect(r.name).toBe("github_search_issues");
      expect(r.args).toEqual({ q: "memory leak" });
    }
  });

  it("accepts a bare code with args nested under `a`", () => {
    const k = c();
    const code = k.codeFor("github_search_issues");
    const r = k.resolve(code, { f: code, a: { q: "x" } });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.args).toEqual({ q: "x" });
  });

  it("accepts a bare code with `a` as a JSON string", () => {
    const k = c();
    const code = k.codeFor("github_create_review");
    const r = k.resolve(code, {
      f: code,
      a: '{"owner":"acme","repo":"web","pull_number":12,"event":"APPROVE"}',
    });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.args.pull_number).toBe(12);
  });

  it("still rejects a name that is neither a tool nor a code", () => {
    const r = c().resolve("totally_made_up", {});
    expect(r.kind).toBe("error");
  });
});

describe("observed: args passed flat instead of nested under `a`", () => {
  // A model that writes t(f="a0", q="…") rather than t(f="a0", a={q:"…"}).
  it("accepts flat args alongside f", () => {
    const k = c();
    const r = k.resolve("t", { f: k.codeFor("github_search_issues"), q: "leak" });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.args).toEqual({ q: "leak" });
  });

  it("prefers `a` when both are present, rather than merging ambiguously", () => {
    const k = c();
    const r = k.resolve("t", {
      f: k.codeFor("github_search_issues"),
      a: { q: "from-a" },
      q: "from-flat",
    });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.args.q).toBe("from-a");
  });

  it("does not treat the dispatcher's own keys as arguments", () => {
    const k = c();
    const r = k.resolve("t", { f: k.codeFor("github_search_issues"), q: "x" });
    if (r.kind === "call") {
      expect(r.args.f).toBeUndefined();
      expect(r.args.a).toBeUndefined();
    }
  });
});

describe("observed: near-miss parameter names (query vs q)", () => {
  // The single most common failure across 360 runs. We do NOT silently remap —
  // guessing which field the caller meant could dispatch wrong data. But the
  // error must name the fix so the retry succeeds first time.
  it("names the likely intended parameter in the error", () => {
    const k = c();
    const r = k.resolve("t", {
      f: k.codeFor("github_search_issues"),
      a: { query: "memory leak" },
    });
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/query/);
    expect(r.message).toMatch(/\bq\b/);
    expect(r.message.toLowerCase()).toMatch(/did you mean|rename|instead/);
  });

  it("still reports plainly when there is no plausible match", () => {
    const k = c();
    const r = k.resolve("t", {
      f: k.codeFor("github_search_issues"),
      a: { wibble: 1, wobble: 2 },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/q/);
  });

  it("does not invent a rename when the required parameter is present", () => {
    const k = c();
    const r = k.resolve("t", {
      f: k.codeFor("github_search_issues"),
      a: { q: "ok", per_page: 10 },
    });
    expect(r.kind).toBe("call");
  });

  it("lists accepted parameters for a genuinely invented one", () => {
    const k = c();
    const r = k.resolve("t", {
      f: k.codeFor("github_search_issues"),
      a: { q: "ok", pageSize: 10 },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/pageSize/);
      expect(r.message).toMatch(/per_page/); // the near match is surfaced
    }
  });
});

describe("observed: enum case drift", () => {
  // Models write "approve" where the schema says "APPROVE". Rejecting is correct
  // — but the message must show the accepted spelling.
  it("rejects a wrong-case enum but shows the accepted values", () => {
    const k = c();
    const r = k.resolve("t", {
      f: k.codeFor("github_create_review"),
      a: { owner: "a", repo: "b", pull_number: 1, event: "approve" },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/APPROVE/);
  });
});

describe("levels 0-2 keep their own contracts", () => {
  it("level 1 is unaffected by code-as-name handling", () => {
    const k = compress(TOOLS, { level: 1 });
    const r = k.resolve("github_search_issues", { q: "x" });
    expect(r.kind).toBe("call");
  });

  it("level 2 gains the same near-miss hint", () => {
    const k = compress(TOOLS, { level: 2 });
    const r = k.resolve("github", {
      op: "search_issues",
      args: { query: "memory leak" },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message.toLowerCase()).toMatch(/did you mean/);
  });
});
