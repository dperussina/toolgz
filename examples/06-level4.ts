/**
 * Level 4: a map a model compiled for you.
 *
 * Levels 0–3 derive the map from your JSON Schema, so they can only rearrange
 * information that is already there. When tool names collide there is nothing left to
 * rearrange — and a map of `manage_x operation` lines tells the model nothing.
 *
 * Level 4 has a model rewrite the corpus first, so each line says what the tool is for.
 *
 * Runs offline — the compiled map is committed. `npx tsx examples/06-level4.ts`
 */
import { readFileSync } from "node:fs";
import { compress, verifyCompiledLine } from "../src/index.js";
import type { Tool } from "../src/types.js";

// Two tools that take identical arguments. Only the name distinguishes them, which is
// exactly the case level 3's map cannot help with.
const myTools: Tool[] = [
  {
    name: "article_update",
    description: "Replace the entire body of an existing article with new content.",
    inputSchema: {
      type: "object",
      properties: { article_id: { type: "number" }, content: { type: "string" } },
      required: ["article_id", "content"],
    },
  },
  {
    name: "article_append",
    description: "Append content to an article without replacing what is already there.",
    inputSchema: {
      type: "object",
      properties: { article_id: { type: "number" }, content: { type: "string" } },
      required: ["article_id", "content"],
    },
  },
];

// Produced ahead of time by `npx toolgz compile --tools ./tools.json --out ./toolmap.json`,
// or in code by compileTools(tools, { complete }) with your own model client. It is
// committed here so this example needs no API key.
const compiled: Record<string, string> = {
  article_update: `def article_update(article_id,content):"overwrite whole article body, old text lost; use article_append to add"`,
  article_append: `def article_append(article_id,content):"add to end, keeping existing text; use over article_update to avoid overwriting"`,
};

// ── what level 3 can and cannot do with these ───────────────────────────────
const three = compress(myTools, { level: 3 });
console.log("level 3 map:");
for (const line of three.systemPreamble.split("\n").filter((l) => /^[a-z]+\d+\s/.test(l))) {
  console.log(`  ${line}`);
}
console.log(`  → ${three.stats.ambiguousMapLines} of ${myTools.length} lines are indistinguishable apart from the name\n`);

const four = compress(myTools, { level: 4, compiled });
console.log("level 4 map:");
for (const line of four.systemPreamble.split("\n").filter((l) => l.startsWith("def "))) {
  console.log(`  ${line}`);
}
console.log(`  → ${four.stats.ambiguousMapLines} ambiguous\n`);

// ── the call is by real function name, and resolve() is unchanged ───────────
const r = four.resolve("t", { f: "article_append", a: { article_id: 42, content: "…" } });
if (r.kind === "call") console.log(`dispatch -> ${r.name}(${JSON.stringify(r.args)})\n`);

// ── the guarantees that make a compiled map safe to trust ───────────────────
// 1. A line that misrepresents the tool is refused before it can be used.
const invented = `def article_append(article_id,content,author):"add to end"`;
console.log(`a line that invents a parameter: ${verifyCompiledLine(invented, myTools[1])}`);

// 2. Staleness is caught at the point of use, because the schema IS the fingerprint.
//    Here the registry has moved on and the tool gained a required parameter.
const moved: Tool[] = JSON.parse(JSON.stringify(myTools));
(moved[1].inputSchema as any).properties.section_title = { type: "string" };
(moved[1].inputSchema as any).required = ["article_id", "section_title", "content"];
const stale = compress(moved, { level: 4, compiled });
console.log(`after the schema changed: ${JSON.stringify(stale.stats.staleCompiledTools)}`);
console.log(`  the stale line is dropped, not shown:`);
console.log(`  ${stale.systemPreamble.split("\n").find((l) => l.includes("article_append"))}`);

// ── the same map, on a level that keeps provider enforcement ────────────────
// A compiled map is not only for level 4. At level 1 the docstring replaces each tool's
// own prose while the real schema still goes on the wire, so the provider keeps enforcing
// arguments — the only option here that shrinks the block without giving anything up.
const one = compress(myTools, { level: 1, compiled });
const plain = compress(myTools, { level: 1 });
console.log(`\nlevel 1            ${plain.stats.compressedChars} chars`);
console.log(`level 1 + compiled ${one.stats.compressedChars} chars   (provider still enforces the schema)`);
console.log(`  description: "${(one.tools as any[])[1].description}"`);
console.log(`  schema kept: ${JSON.stringify((one.tools as any[])[1].input_schema.required)}`);

// 3. In CI, make a partial map fail instead of quietly degrading.
try {
  compress(moved, { level: 4, compiled, requireCompiled: true });
} catch (e) {
  console.log(`\nrequireCompiled: ${(e as Error).message.split("\n")[0]}`);
}
