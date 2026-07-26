/**
 * Live end-to-end check against the real API.
 *
 * Skipped unless ANTHROPIC_API_KEY is set, so `npm test` stays offline and fast.
 * Run with: ANTHROPIC_API_KEY=… npx vitest run tests/integration
 *
 * This is the test that proves the library is actually drop-in: it exercises
 * compress → provider adapter → live model → resolve, at every level, and
 * asserts the real tool name and arguments come back out the far end.
 */
import "dotenv/config";
import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { compress, forAnthropic } from "../../src/index.js";
import type { Tool } from "../../src/types.js";

const LIVE = !!process.env.ANTHROPIC_API_KEY;

const TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The account owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        title: { type: "string", description: "The title of the issue." },
        body: { type: "string", description: "The issue body in Markdown." },
      },
      required: ["owner", "repo", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "github_search_issues",
    description: "Search issues across GitHub with a query string.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "The GitHub search query." },
        sort: { type: "string", enum: ["created", "updated", "comments"], description: "Sort field." },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_post_message",
    description: "Post a message to a Slack channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel id or name." },
        text: { type: "string", description: "Message text." },
      },
      required: ["channel", "text"],
      additionalProperties: false,
    },
  },
];

describe.skipIf(!LIVE)("live round-trip", () => {
  const client = new Anthropic();

  it.each([0, 1, 2, 3] as const)(
    "level %i dispatches the real tool with the real arguments",
    async (level) => {
      const c = compress(TOOLS, { level });
      const { tools, system } = forAnthropic(c);
      const messages: any[] = [
        {
          role: "user",
          // Worded to leave no room for a defensible variant. "owner=acme repo=web"
          // used to flake: the model would send repo="acme/web", because GitHub's own
          // convention is the owner/repo slug. That is schema-valid and the library
          // translated it faithfully, so the assertion was wrong, not the code —
          // it pinned a formatting choice the prompt had left open.
          content:
            "Open a GitHub issue. The owner argument is exactly the string \"acme\". " +
            "The repo argument is exactly the string \"web\" — the repo name only, " +
            "never a combined owner/repo slug. The title is \"Ship it\".",
        },
      ];
      let dispatched: any = null;
      // Kept for the failure message. This test asserts real model behaviour on a
      // single sample, so it flakes (~1 in 8 whole-file runs observed) — and once on
      // level 0, the passthrough arm, where the tool payload is untouched. That
      // points at model variance rather than compression, but a bare
      // `expected null not to be null` cannot tell the two apart, so record enough
      // to diagnose the next occurrence instead of re-running to guess.
      const trace: string[] = [];

      for (let turn = 0; turn < 6 && !dispatched; turn++) {
        const res: any = await client.messages.create({
          model: "claude-opus-5",
          max_tokens: 2000,
          system: [{ type: "text", text: "You are an ops agent. Use tools. Do not ask questions." }, ...(system ?? [])],
          tools: tools as any,
          messages,
        });
        const calls = res.content.filter((b: any) => b.type === "tool_use");
        if (!calls.length) {
          const said = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
          trace.push(`turn ${turn}: no tool_use. stop=${res.stop_reason} text=${JSON.stringify(said.slice(0, 300))}`);
          break;
        }
        messages.push({ role: "assistant", content: res.content });
        const results = calls.map((call: any) => {
          const r = c.resolve(call.name, call.input);
          trace.push(`turn ${turn}: ${call.name}(${JSON.stringify(call.input)}) -> ${r.kind}${r.kind === "error" ? `: ${r.message}` : ""}`);
          if (r.kind === "call") {
            dispatched = r;
            return { type: "tool_result", tool_use_id: call.id, content: '{"number":42}' };
          }
          if (r.kind === "meta")
            return { type: "tool_result", tool_use_id: call.id, content: r.result };
          return { type: "tool_result", tool_use_id: call.id, content: `Error: ${r.message}`, is_error: true };
        });
        messages.push({ role: "user", content: results });
      }

      const ctx = `level ${level}, mapStyle ${c.stats.mapStyle ?? "n/a"}\n  ${trace.join("\n  ") || "(no turns recorded)"}`;
      expect(dispatched, `never reached a dispatch —\n  ${ctx}`).not.toBeNull();
      expect(dispatched.name, ctx).toBe("github_create_issue");
      expect(dispatched.args.owner, ctx).toBe("acme");
      expect(dispatched.args.repo, ctx).toBe("web");
      // If this fires at level 1-3 it is a library defect: `validate` checks against the
      // ORIGINAL schema, so a wrong-typed required field should surface as kind:"error",
      // never as a dispatch. At level 0 nothing is compressed and nothing is validated,
      // so it only reports what the provider let through.
      expect(typeof dispatched.args.title, ctx).toBe("string");
    },
    120_000,
  );
});
