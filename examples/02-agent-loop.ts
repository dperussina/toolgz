/**
 * The full loop, offline. This is the shape every integration takes.
 *
 * A model call returns tool_use blocks; you pass each to resolve() and act on the KIND.
 * Here the "model" is scripted so the example runs with no key and no cost, and covers
 * all three outcomes including a recovery.
 *
 *   npx tsx examples/02-agent-loop.ts
 */
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const myTools: Tool[] = [
  {
    name: "scorecard_lf",
    description: "Lost Freight weekly rollup per FC.",
    inputSchema: { type: "object", properties: { week: { type: "string" } } },
  },
  {
    name: "scorecard_lf_daily",
    description: "Lost Freight DAILY rollup per FC.",
    inputSchema: { type: "object", properties: { day: { type: "string" } } },
  },
];

const c = compress(myTools, { level: 3 });

// What you would actually send:
//   system: YOUR_PROMPT + c.systemPreamble
//   tools:  c.tools
console.log("--- the model sees this map ---");
console.log(c.systemPreamble.split("</toolmap>")[0] + "</toolmap>\n");

// Your real dispatcher. It never learns that compression happened.
async function myDispatch(name: string, args: Record<string, unknown>) {
  return { ok: true, rows: 412, tool: name, args };
}

// A scripted conversation covering all three resolve() outcomes.
const scriptedTurns: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "q", args: { s: "lost freight" } },                  // model searches the map
  { name: "t", args: { f: "bad-code", a: {} } },               // model guesses wrong
  { name: "t", args: { f: c.codeFor("scorecard_lf_daily"), a: { day: "2026-07-26" } } },
];

for (const [i, raw] of scriptedTurns.entries()) {
  const r = c.resolve(raw.name, raw.args);

  if (r.kind === "call") {
    // A real tool call. Dispatch it and feed the result back as a tool_result.
    const result = await myDispatch(r.name, r.args);
    console.log(`turn ${i + 1}  CALL   ${r.name} -> ${JSON.stringify(result)}`);
  } else if (r.kind === "meta") {
    // The model asked the LIBRARY something (expand a code, search the map). Answer it
    // yourself as a tool_result — do not send this to your own backend.
    console.log(`turn ${i + 1}  META   reply with: ${r.result.slice(0, 70)}…`);
  } else {
    // A mistake. The message is written for the model to read: return it as a
    // tool_result and it will usually correct itself on the next turn.
    console.log(`turn ${i + 1}  ERROR  return to model: ${r.message}`);
    console.log(`         recoverable: ${r.recoverable}`);
  }
}
