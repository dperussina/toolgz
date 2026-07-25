import "dotenv/config";
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" });

const hard = [{ role: "user" as const, content:
  "A 3x3 grid is filled with the integers 1..9, each once. Row sums are all distinct primes, and the main diagonal sums to 15. How many such grids exist? Work carefully and give the exact count." }];

async function run(label: string, extra: any) {
  const t = Date.now();
  try {
    const r: any = await client.chat.completions.create({ model: "grok-4.5", messages: hard, max_tokens: 30000, ...extra });
    const u = r.usage;
    console.log(`${label.padEnd(28)} reasoning=${String(u.completion_tokens_details.reasoning_tokens).padStart(6)} completion=${String(u.completion_tokens).padStart(5)} total=${String(u.total_tokens).padStart(6)} ticks=${u.cost_in_usd_ticks} ${Date.now()-t}ms`);
  } catch (e: any) {
    console.log(`${label.padEnd(28)} ERROR ${e.status} ${JSON.stringify(e.error ?? e.message)}`);
  }
}

for (const eff of ["low", "medium", "high", "xhigh", "bogus-value-zzz"]) {
  await run(`reasoning_effort=${eff}`, { reasoning_effort: eff });
}
await run("(omitted)", {});
