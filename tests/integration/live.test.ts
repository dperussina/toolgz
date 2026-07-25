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
        { role: "user", content: "Open a GitHub issue in owner=acme repo=web titled 'Ship it'." },
      ];
      let dispatched: any = null;

      for (let turn = 0; turn < 6 && !dispatched; turn++) {
        const res: any = await client.messages.create({
          model: "claude-opus-5",
          max_tokens: 2000,
          system: [{ type: "text", text: "You are an ops agent. Use tools. Do not ask questions." }, ...(system ?? [])],
          tools: tools as any,
          messages,
        });
        const calls = res.content.filter((b: any) => b.type === "tool_use");
        if (!calls.length) break;
        messages.push({ role: "assistant", content: res.content });
        const results = calls.map((call: any) => {
          const r = c.resolve(call.name, call.input);
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

      expect(dispatched).not.toBeNull();
      expect(dispatched.name).toBe("github_create_issue");
      expect(dispatched.args.owner).toBe("acme");
      expect(dispatched.args.repo).toBe("web");
      expect(typeof dispatched.args.title).toBe("string");
    },
    120_000,
  );
});
