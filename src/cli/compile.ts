#!/usr/bin/env node
/**
 * `npx toolgz compile` — turn a tool catalogue into a compiled Python map.
 *
 * Bring your own model, provider and key. This talks to the provider over `fetch`, which
 * is built into Node, so installing toolgz still installs nothing else.
 *
 *   npx toolgz compile --tools ./tools.json --out ./toolmap.json
 *   npx toolgz compile --tools ./tools.json --provider openai --model gpt-5.6-sol
 *
 * The key comes from ANTHROPIC_API_KEY or OPENAI_API_KEY. Nothing is written until every
 * line has been verified against your real schemas.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { compileTools, type Completion } from "../compile.js";
import type { Tool } from "../types.js";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  return argv[argv.indexOf(hit) + 1] ?? d;
};

const USAGE = `toolgz compile — compile a tool catalogue into a Python map for level 4

  --tools <path>     JSON file: an array of tools, or { tools: [...] } (required)
  --out <path>       where to write the compiled map (default ./toolmap.json)
  --provider <name>  anthropic | openai            (default anthropic)
  --model <id>       model to compile with         (default per provider)
  --batch <n>        tools per request             (default 12)
  --max-doc <n>      target docstring length       (default 110)

Key is read from ANTHROPIC_API_KEY or OPENAI_API_KEY.

  npx toolgz compile --tools ./tools.json --out ./toolmap.json

Then:

  import map from "./toolmap.json" with { type: "json" };
  const c = compress(myTools, { level: 4, compiled: map });`;

function fail(msg: string): never {
  console.error(`toolgz compile: ${msg}\n\n${USAGE}`);
  process.exit(1);
}

/** Accepts a bare array, { tools }, or MCP's { result: { tools } }. */
function readTools(path: string): Tool[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    fail(`could not read ${path}: ${e.message}`);
  }
  const list =
    Array.isArray(raw) ? raw
    : Array.isArray((raw as any)?.tools) ? (raw as any).tools
    : Array.isArray((raw as any)?.result?.tools) ? (raw as any).result.tools
    : null;
  if (!list) fail(`${path} is not a tool array, { tools: [...] } or { result: { tools: [...] } }`);
  if (!list.length) fail(`${path} contains no tools`);
  for (const t of list) if (!t?.name) fail(`a tool in ${path} has no name`);
  return list as Tool[];
}

const PROVIDERS: Record<string, { env: string; model: string; call: (k: string, m: string) => Completion }> = {
  anthropic: {
    env: "ANTHROPIC_API_KEY",
    model: "claude-opus-5",
    call: (key, model) => async ({ system, user }) => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: "user", content: user }] }),
      });
      const j: any = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? JSON.stringify(j).slice(0, 300));
      return (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    },
  },
  openai: {
    env: "OPENAI_API_KEY",
    model: "gpt-5.6-sol",
    call: (key, model) => async ({ system, user }) => {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      const j: any = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? JSON.stringify(j).slice(0, 300));
      return j.choices?.[0]?.message?.content ?? "";
    },
  },
};

async function main() {
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 1);
  }
  const toolsPath = flag("tools");
  if (!toolsPath) fail("--tools is required");

  const providerName = (flag("provider", "anthropic") ?? "anthropic").toLowerCase();
  const provider = PROVIDERS[providerName];
  if (!provider) fail(`unknown provider "${providerName}". Known: ${Object.keys(PROVIDERS).join(", ")}`);

  const key = process.env[provider.env];
  if (!key) fail(`${provider.env} is not set`);

  const tools = readTools(toolsPath);
  const out = flag("out", "./toolmap.json")!;
  const model = flag("model", provider.model)!;

  console.error(`compiling ${tools.length} tools with ${providerName}/${model}…`);
  const result = await compileTools(tools, {
    complete: provider.call(key, model),
    batchSize: Number(flag("batch", "12")),
    maxDocChars: Number(flag("max-doc", "110")),
    onProgress: (done, total) => process.stderr.write(`  ${done}/${total}\r`),
  });

  writeFileSync(out, JSON.stringify(result.compiled, null, 0) + "\n");
  console.error(
    `\nwrote ${out} — ${result.stats.compiled}/${result.stats.total} tools, ` +
      `${result.stats.chars} chars (${result.stats.charsPerTool}/tool)`,
  );
  for (const r of result.rejected) console.error(`  REJECTED ${r.name}: ${r.reason}`);
  for (const d of result.danglingReferences) {
    console.error(`  CHECK ${d.name}: docstring points at "${d.mentions}", not in this corpus`);
  }
  if (result.rejected.length) {
    console.error(
      `\n${result.rejected.length} tool(s) failed verification and were left out. At level 4 they` +
        ` fall back to a bare signature line and are counted in stats.uncompiledTools.`,
    );
  }
}

main().catch((e) => {
  console.error(`toolgz compile: ${e.message}`);
  process.exit(1);
});
