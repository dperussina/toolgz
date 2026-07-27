/**
 * Compile the real corpus to minified Python, using Anthropic as the model.
 *
 *   npx tsx -r dotenv/config bench/compile-python.ts [--limit=N] [--out=path] [--model=id]
 *
 * All the logic lives in `src/compile.ts`. This file is only the part that is properly
 * the caller's job: bringing a client and a key. That is the whole point of the
 * `complete` callback — the library never imports an SDK, so a consumer can use any
 * provider without toolgz growing a dependency.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { compileTools } from "../src/compile.js";
import { REAL_TOOLS } from "./fixtures/real.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const LIMIT = Number(arg("limit") ?? 0);
const OUT = arg("out") ?? new URL("./fixtures/python-map.json", import.meta.url).pathname;
const MODEL = arg("model") ?? "claude-opus-5";

const tools = (REAL_TOOLS as any[])
  .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  .slice(0, LIMIT || undefined);

const client = new Anthropic();

const result = await compileTools(tools as any, {
  complete: async ({ system, user }) => {
    const res: any = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
    });
    return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  },
  onProgress: (done, total) => process.stdout.write(`  compiled ${done}/${total}\r`),
});

writeFileSync(OUT, JSON.stringify(result.compiled, null, 0) + "\n");
console.log(`\nwrote ${OUT}`);
console.log(`  ${result.stats.compiled}/${result.stats.total} tools, ${result.stats.chars} chars (${result.stats.charsPerTool}/tool)`);
for (const r of result.rejected) console.log(`  REJECTED ${r.name}: ${r.reason}`);
