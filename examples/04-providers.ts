/**
 * The four provider shapes, side by side. Offline — no keys needed.
 *
 * Each provider wants tools in a different envelope. The adapters do that translation so
 * you never hand-build it. Two gotchas are demonstrated rather than described.
 *
 *   npx tsx examples/04-providers.ts
 */
import { compress } from "../src/index.js";
import { forAnthropic, forOpenAI, forOpenAIResponses, forGemini } from "../src/providers/index.js";
import type { Tool } from "../src/types.js";

const myTools: Tool[] = [
  {
    name: "svc_fetch_report",
    description: "Fetch a report.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        // Two shapes Gemini rejects outright, on purpose — see the note at the end.
        tags: { type: "array" },
        depth: { type: "number", enum: [1, 2, 3] },
      },
      required: ["id"],
    },
  },
];

const c = compress(myTools, { level: 3 });

const a = forAnthropic(c);
console.log("ANTHROPIC — messages.create");
console.log(`  tools: ${a.tools.length}   system: ${Array.isArray(a.system) ? `${a.system.length} block(s), cache_control on the map` : typeof a.system}`);

const o = forOpenAI(c);
console.log("\nOPENAI — /v1/chat/completions");
console.log(`  tools: ${o.tools.length}, nested shape: ${JSON.stringify(Object.keys((o.tools as any[])[0]))}`);

const or = forOpenAIResponses(c);
console.log("\nOPENAI — /v1/responses  (required for tools + reasoning on GPT-5.x)");
console.log(`  tools: ${or.tools.length}, FLAT shape: ${JSON.stringify(Object.keys((or.tools as any[])[0]))}`);
console.log("  ^ use this one if you set reasoning effort; the nested shape is rejected there");

const g = forGemini(c);
console.log("\nGEMINI — generateContent");
console.log(`  tools: ${g.tools.length}  <- ONE wrapper object, not one per tool`);
console.log(`  declarations inside it: ${(g.tools as any[])[0].functionDeclarations.length}`);
console.log("  ^ count tools[0].functionDeclarations.length, not tools.length");

// Gemini rejects the WHOLE request on one bad declaration. The adapter repairs three
// forms real MCP servers emit, so you do not have to pre-clean your schemas.
const l1 = forGemini(compress(myTools, { level: 1 }));
const props = (l1.tools as any[])[0].functionDeclarations[0].parameters.properties;
console.log("\n  repairs applied at level 1 (Gemini would 400 without them):");
console.log(`    tags  ${JSON.stringify(myTools[0].inputSchema!.properties.tags)} -> ${JSON.stringify(props.tags)}`);
console.log(`    depth ${JSON.stringify(myTools[0].inputSchema!.properties.depth)} -> ${JSON.stringify(props.depth)}`);
console.log("    the dropped enum is still enforced by resolve():");
const bad = compress(myTools, { level: 1 }).resolve("svc_fetch_report", { id: "x", depth: 99 });
console.log(`      depth=99 -> ${bad.kind}${bad.kind === "error" ? `: ${bad.message.slice(0, 60)}…` : ""}`);
