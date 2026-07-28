/**
 * Generate docs/BEFORE-AFTER.md by actually running the library.
 *
 *   npx tsx docs/generate-examples.ts
 *
 * Everything in the output file is produced by calling `compress()` and
 * `resolve()` for real — no hand-written "representative" examples. Token
 * counts come from Anthropic's count_tokens endpoint when ANTHROPIC_API_KEY is
 * present, and are omitted rather than estimated when it is not.
 *
 * tests/examples.test.ts regenerates and compares, so the committed file cannot
 * drift from the code that produced it.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

/**
 * Level 4's map is compiled by a model ahead of time, so the artifact is committed
 * rather than regenerated here — this script runs in CI and must not need a key for
 * the parts that do not measure tokens. Refresh with:
 *   npx toolgz compile --tools <DEMO_TOOLS as json> --out docs/demo-toolmap.json
 */
const COMPILED: Record<string, string> = JSON.parse(
  readFileSync(new URL("./demo-toolmap.json", import.meta.url), "utf8"),
);

/** A small, deliberately realistic tool set — three tools, two namespaces. */
export const DEMO_TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description:
      "Create a new issue in a GitHub repository. The issue will be created by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "The account owner of the repository. Case insensitive.",
        },
        repo: {
          type: "string",
          description: "The name of the repository without the .git extension.",
        },
        title: { type: "string", description: "The title of the issue." },
        body: {
          type: "string",
          description: "The contents of the issue, in GitHub-flavoured Markdown.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to associate with this issue.",
        },
      },
      required: ["owner", "repo", "title"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
  },
  {
    name: "github_search_issues",
    description:
      "Search issues and pull requests across all of GitHub using a query string.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "The search query, using GitHub search syntax.",
        },
        sort: {
          type: "string",
          enum: ["comments", "created", "updated"],
          description: "The field to sort results by.",
        },
        per_page: {
          type: "integer",
          description: "Number of results per page, maximum 100.",
        },
      },
      required: ["q"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
  },
  {
    name: "slack_post_message",
    description: "Post a message to a Slack channel on behalf of the app.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "The channel ID or name to post the message to.",
        },
        text: { type: "string", description: "The message text to post." },
        thread_ts: {
          type: "string",
          description: "Timestamp of a parent message, to reply in a thread.",
        },
      },
      required: ["channel", "text"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
  },
];

const SYSTEM = "You are an operations agent. Use the tools available to you.";

const fence = (lang: string, body: string) =>
  "```" + lang + "\n" + body.replace(/\n+$/, "") + "\n```";

/** Real token counts, or null when no key is configured. */
async function tokenCounter(): Promise<
  ((tools: unknown[], system: string) => Promise<number>) | null
> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  return async (tools, system) => {
    const r = await client.messages.countTokens({
      model: "claude-opus-5",
      ...(tools.length ? { tools: tools as any } : {}),
      system,
      messages: [{ role: "user", content: "x" }],
    });
    return r.input_tokens;
  };
}

async function main() {
  const count = await tokenCounter();
  const out: string[] = [];

  const before = DEMO_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const baseline = count ? await count([], SYSTEM) : null;
  const beforeTokens = count ? await count(before, SYSTEM) : null;

  out.push(
    "# Before and after — generated, not illustrated",
    "",
    "Every block on this page is emitted by `docs/generate-examples.ts`, which",
    "calls the real `compress()` and `resolve()`. Regenerate with:",
    "",
    fence("bash", "npx tsx docs/generate-examples.ts"),
    "",
    "`tests/examples.test.ts` regenerates and compares, so this file cannot drift",
    "from the code that produced it.",
    "",
    "toolgz modifies exactly two things: **the tools array** and **the system",
    "prompt**. Nothing else about your request changes. Both are shown in full",
    "below, for the same three tools.",
    "",
    count
      ? `Token counts are from Anthropic's \`count_tokens\` endpoint on \`claude-opus-5\`, measured against a ${baseline}-token empty baseline (system prompt and a one-character user message, no tools).`
      : "_Token counts omitted: no ANTHROPIC_API_KEY was set when this was generated._",
    "",
    "---",
    "",
    "## The input",
    "",
    `Three tools across two namespaces, in the shape an MCP server produces.${
      count ? ` As sent uncompressed, the request is **${beforeTokens} tokens**.` : ""
    }`,
    "",
    fence("json", JSON.stringify(before, null, 2)),
    "",
    "And the system prompt, untouched:",
    "",
    fence("text", SYSTEM),
    "",
    "---",
    "",
  );

  const LEVELS = [
    {
      level: 1 as const,
      title: "Level 1 — signature lines (the default)",
      note:
        "One native tool per input tool, real names kept. The JSON Schema loses " +
        "its prose and boilerplate but keeps everything that constrains sampling: " +
        "types, `enum`, `required`, array item types. The system prompt is " +
        "**unchanged** — level 1 adds no preamble.",
    },
    {
      level: 2 as const,
      title: "Level 2 — one tool per namespace",
      note:
        "Operations collapse into a compound tool per namespace, with the op " +
        "names as an `enum` so the sampler still constrains that field. " +
        "Arguments move into a generic object, which is where provider-side " +
        "schema enforcement is lost. The system prompt is still unchanged.",
    },
    {
      level: 3 as const,
      title: "Level 3 — dispatcher plus a cached map",
      note:
        "Two tools total, regardless of how many you started with: `t` to " +
        "dispatch and `q` to look up. This is the level that also modifies the " +
        "system prompt — the map goes there so it sits behind a cache breakpoint.",
    },
    {
      level: 4 as const,
      title: "Level 4 — a map a model compiled for you",
      note:
        "Level 3's dispatcher, but the map is minified Python that a model wrote " +
        "from your corpus ahead of time, so each line says what the tool is *for* " +
        "and when to prefer it over a similar name. Deliberately larger than level " +
        "3: it is buying back the semantics level 3 deletes. Requires a compiled " +
        "artifact — `npx toolgz compile` — and the model calls by real function " +
        "name rather than by code.",
    },
  ];

  for (const { level, title, note } of LEVELS) {
    const c = compress(DEMO_TOOLS, level === 4 ? { level, compiled: COMPILED } : { level });
    const sys = c.systemPreamble ? `${SYSTEM}\n\n${c.systemPreamble}` : SYSTEM;
    const after = count ? await count(c.tools as unknown[], sys) : null;

    out.push(`## ${title}`, "", note, "");

    if (count && beforeTokens && after) {
      const saved = Math.round((1 - (after - baseline!) / (beforeTokens - baseline!)) * 100);
      out.push(
        `**${after} tokens** total, against ${beforeTokens} uncompressed — ` +
          `the tool block itself goes from ${beforeTokens - baseline!} tokens to ` +
          `${after - baseline!}, a **${saved}% reduction**.`,
        "",
      );
    }

    out.push(
      `### Tools array — ${(c.tools as unknown[]).length} ${
        (c.tools as unknown[]).length === 1 ? "entry" : "entries"
      }`,
      "",
      fence("json", JSON.stringify(c.tools, null, 2)),
      "",
      "### System prompt",
      "",
      c.systemPreamble
        ? fence("text", sys)
        : `Unchanged:\n\n${fence("text", SYSTEM)}`,
      "",
    );

    // Show a real encode → resolve round trip at this level.
    const args = { owner: "acme", repo: "web", title: "Retry logic drops errors" };
    const raw = c.encodeCallForTest("github_create_issue", args);
    const resolved = c.resolve(raw.name, raw.args);

    out.push(
      "### Round trip",
      "",
      "What the model emits at this level:",
      "",
      fence("json", JSON.stringify(raw, null, 2)),
      "",
      "What `resolve()` hands your dispatcher — the original name and arguments:",
      "",
      fence("json", JSON.stringify(resolved, null, 2)),
      "",
      "---",
      "",
    );
  }

  // Error and lookup paths, at the default level.
  const c3 = compress(DEMO_TOOLS, { level: 3 });
  const missing = c3.resolve("t", {
    f: c3.codeFor("github_create_issue"),
    a: { owner: "acme" },
  });
  // The most common real failure across 360 runs: a model passing `query` to a
  // parameter named `q`. Shown here because the error is what makes the retry
  // land first time.
  const nearMiss = c3.resolve("t", {
    f: c3.codeFor("github_search_issues"),
    a: { query: "memory leak org:acme" },
  });
  // Observed on claude-opus-5: the map code used as the tool name.
  const codeAsName = c3.resolve(c3.codeFor("slack_post_message"), {
    channel: "C123",
    text: "shipped",
  });
  const unknown = c3.resolve("t", { f: "zz9", a: {} });
  const lookup = c3.resolve("q", { c: c3.codeFor("github_search_issues") });
  const search = c3.resolve("q", { s: "slack" });

  out.push(
    "## The recovery paths, at level 3",
    "",
    "These are the outputs your loop feeds back to the model. They are written",
    "for the model to read, not for a log file.",
    "",
    "**Missing a required argument** — validated against your *original* schema:",
    "",
    fence("json", JSON.stringify(missing, null, 2)),
    "",
    "**An invented code:**",
    "",
    fence("json", JSON.stringify(unknown, null, 2)),
    "",
    "**A near-miss parameter name** — the most common real failure. It is not",
    "silently remapped (that would guess at intent and could dispatch wrong",
    "data); the error names the fix instead:",
    "",
    fence("json", JSON.stringify(nearMiss, null, 2)),
    "",
    "**The map code used as the tool name** — observed in real runs, and",
    "accepted rather than rejected, since a code cannot be mistaken for",
    "anything else:",
    "",
    fence("json", JSON.stringify(codeAsName, null, 2)),
    "",
    "**The model asking what a code takes** (`q` by code):",
    "",
    fence("json", JSON.stringify(lookup, null, 2)),
    "",
    "**The model searching the map** (`q` by keyword):",
    "",
    fence("json", JSON.stringify(search, null, 2)),
    "",
    "---",
    "",
    "## Scale",
    "",
    "Three tools is a demo, and the shape changes with scale in a way worth seeing.",
    "Level 3 sends two tools no matter how many you start with — but its **map** grows",
    "one line per tool, so level 3 is not flat either. Level 2's per-namespace payload",
    "grows more slowly, and **overtakes level 3 somewhere between 100 and 300 tools**:",
    "",
  );

  // Character-count scaling table (no API calls — this is a shape argument).
  const rows: string[] = [
    "| tools | level 0 | level 1 | level 2 | level 3 | wire tools at L3+ |",
    "|---:|---:|---:|---:|---:|---:|",
  ];
  for (const n of [3, 10, 30, 100, 300, 600]) {
    const many: Tool[] = Array.from({ length: n }, (_, i) => ({
      ...DEMO_TOOLS[i % DEMO_TOOLS.length],
      name: `ns${i % 9}_op_${i}`,
    }));
    const sizes = [0, 1, 2, 3].map(
      (l) => compress(many, { level: l as any }).stats.compressedChars,
    );
    const wire = (compress(many, { level: 3 }).tools as unknown[]).length;
    rows.push(
      `| ${n} | ${sizes[0].toLocaleString()} | ${sizes[1].toLocaleString()} | ${sizes[2].toLocaleString()} | ${sizes[3].toLocaleString()} | ${wire} |`,
    );
  }
  out.push(
    ...rows,
    "",
    "**Level 2 is smaller than level 3 past ~300 tools**, and the gap widens — by 600",
    "tools it is roughly a third smaller. That is a real crossover and it is not a",
    "reason to switch by itself: level 2 measured 16 malformed arguments against level",
    "3's zero over 60 runs each (RESULTS.md Round 1-6), so it buys size with argument",
    "quality. Level 4 is omitted from this table because it needs a compiled map, which",
    "is generated per corpus rather than synthesised here; see its section above for the",
    "three-tool figure and RESULTS.md Round 10 for the measured comparison.",
    "",
    "Figures are characters of rendered payload (tools + preamble), which is a",
    "shape argument rather than a billing one — token counts above come from the",
    "provider's own endpoint.",
    "",
    "See [RESULTS.md](RESULTS.md) for measured token, accuracy, latency and cost",
    "figures across four providers, and the README for how to wire it up.",
  );

  const md = out.join("\n") + "\n";
  writeFileSync(new URL("./BEFORE-AFTER.md", import.meta.url).pathname, md);
  console.log(
    `wrote docs/BEFORE-AFTER.md (${md.length} chars, token counts: ${count ? "live" : "omitted"})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
