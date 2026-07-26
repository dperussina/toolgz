/**
 * Per-model style selection, and reading `stats` to see what actually happened.
 *
 * Offline. `npx tsx examples/05-per-model.ts`
 */
import { compress, POLICY, CONSERVATIVE_DEFAULT } from "../src/index.js";
import { readFileSync } from "node:fs";

const harvested: any[] = JSON.parse(
  readFileSync(new URL("../bench/fixtures/real-mcp-tools.json", import.meta.url), "utf8"),
);
const myTools = harvested.map((t) => ({
  name: t.name, description: t.description, inputSchema: t.input_schema,
}));

// Omit `model` and nothing changes — this is the default every existing caller gets.
console.log(`default style: ${compress(myTools, { level: 3 }).stats.mapStyle}\n`);

// The table is generated from committed sweep results, and exported so a choice is never
// a black box.
console.log("measured policy (cost objective only — occupancy showed no winner):");
for (const p of POLICY) {
  console.log(`  ${p.model.padEnd(24)} ${p.mapStyle.padEnd(14)} ${p.effectPct}%  n=${p.n}  ${p.sweep}`);
}
console.log(`  anything absent falls back to ${CONSERVATIVE_DEFAULT}\n`);

for (const model of ["claude-opus-5", "gemini-3.1-pro-preview", "gpt-5.6-sol", "grok-4.5", "some-model-2030"]) {
  const occ = compress(myTools, { level: 3, model }).stats.mapStyle;
  const cost = compress(myTools, { level: 3, model, objective: "cost" }).stats.mapStyle;
  console.log(`  ${model.padEnd(24)} occupancy=${occ.padEnd(14)} cost=${cost}`);
}

// grok-4.5 keeps the default under `cost` because `explicit` measured +13.2% there.
// An absent row means "no measured improvement", never "untested".

console.log("\nstats always says what was used, so nothing is substituted silently:");
const c = compress(myTools, { level: 3, model: "gpt-5.6-sol", objective: "cost" });
console.log(`  mapStyle          ${c.stats.mapStyle}`);
console.log(`  requestedMapStyle ${c.stats.requestedMapStyle ?? "(you did not ask for one)"}`);
console.log(`  fallbackReason    ${c.stats.fallbackReason ?? "(nothing was substituted)"}`);
console.log(`  savedPct          ${c.stats.savedPct}%  <- CHARACTER saving, runs a few points`);
console.log(`                        optimistic vs tokens. Measure with your provider's`);
console.log(`                        counter for anything you publish.`);
