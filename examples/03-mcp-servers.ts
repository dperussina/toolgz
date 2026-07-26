/**
 * Wiring real MCP servers.
 *
 * `tools/list` gives you `{ name, description, inputSchema }` per tool — exactly what
 * compress() takes, so there is no adapter layer. This example uses the 149 tools
 * committed in bench/fixtures, harvested from 14 live MCP servers.
 *
 *   npx tsx examples/03-mcp-servers.ts
 */
import { compress, recommendLevel } from "../src/index.js";
import { readFileSync } from "node:fs";

type McpTool = { server: string; name: string; description: string; input_schema: any };
const harvested: McpTool[] = JSON.parse(
  readFileSync(new URL("../bench/fixtures/real-mcp-tools.json", import.meta.url), "utf8"),
);

// In your app this is the concatenation of every server's tools/list result.
const myTools = harvested.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.input_schema,
}));

const servers = new Set(harvested.map((t) => t.server));
console.log(`${myTools.length} tools from ${servers.size} MCP servers\n`);

const { level, reason } = recommendLevel(myTools);
console.log(`recommended: level ${level}`);
console.log(`  ${reason}\n`);

for (const lvl of [0, 1, 2, 3] as const) {
  const c = compress(myTools, { level: lvl });
  console.log(
    `  level ${lvl}: ${String(c.tools.length).padStart(3)} tools on the wire, ` +
      `${String(c.stats.compressedChars).padStart(6)} chars, savedPct ${c.stats.savedPct}%`,
  );
}

// Duplicate names across servers are a real hazard: two servers may both expose
// `search`. compress() throws rather than silently dropping one.
console.log("\nname collisions across servers:");
const seen = new Map<string, string>();
let collisions = 0;
for (const t of harvested) {
  const prior = seen.get(t.name);
  if (prior && prior !== t.server) {
    console.log(`  ${t.name}: ${prior} and ${t.server}`);
    collisions++;
  }
  seen.set(t.name, t.server);
}
console.log(collisions === 0 ? "  none in this corpus" : `  ${collisions} — prefix them per server before compressing`);

// If you do have collisions, namespace them yourself first:
//   const prefixed = tools.map(t => ({ ...t, name: `${t.server}_${t.name}` }));
