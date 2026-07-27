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
import { compileTools, verifyCompiledLine, COMPILE_SYSTEM_PROMPT } from "../src/index.js";
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
