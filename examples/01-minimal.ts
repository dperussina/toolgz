/**
 * The smallest useful thing: compress, then translate a call back.
 *
 * Runs offline — no API key, no network. `npx tsx examples/01-minimal.ts`
 */
import { compress, recommendLevel } from "../src/index.js";
import type { Tool } from "../src/types.js";

// Whatever your MCP client or SDK already gives you.
const myTools: Tool[] = [
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
    name: "github_create_issue",
    description: "Open a new issue on a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
];

// recommendLevel ADVISES — it does not act. You pass its answer back in yourself.
// Two tools is a tiny block, so this returns level 1, which keeps the provider's own
// argument validation.
const { level, reason } = recommendLevel(myTools);
console.log(`recommended level ${level}\n  ${reason}\n`);

const c = compress(myTools, { level });

// Worth being explicit about, because it catches people out: compress() with no level
// is level 1 forever. It does not upgrade itself when your tool array grows, because
// level 3 gives up provider-side schema checking and that is your call to make.
console.log(`compress(myTools)            -> level ${compress(myTools).stats.level}`);
console.log(`compress(myTools, {level:3}) -> level ${compress(myTools, { level: 3 }).stats.level}\n`);

// Send `c.tools` instead of your tool array, and append `c.systemPreamble` to your
// system prompt (it is "" below level 3, so appending it is always safe).
console.log(`tools on the wire : ${c.tools.length}`);
console.log(`system preamble   : ${c.systemPreamble.length} chars`);
console.log(`estimated saving  : ${c.stats.savedPct}%\n`);

// When the model calls something, hand the raw name and args to resolve(). You get
// back the REAL tool name and arguments — your dispatch code does not change.
const r = c.resolve("github_search_issues", { q: "memory leak" });
if (r.kind === "call") {
  console.log(`dispatch -> ${r.name}(${JSON.stringify(r.args)})`);
} else if (r.kind === "meta") {
  console.log(`model asked the library a question; reply with: ${r.result}`);
} else {
  console.log(`tell the model: ${r.message}`);
}
