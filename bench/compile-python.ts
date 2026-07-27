/**
 * Compile a tool corpus into minified Python, using a model to do the compressing.
 *
 *   npx tsx -r dotenv/config bench/compile-python.ts [--limit=N] [--out=path]
 *
 * This is a BUILD step, not a runtime one. The library has zero runtime dependencies and
 * cannot call an API; this script produces an artifact the caller passes to compress().
 *
 * The safety property that makes it usable: the model writes only the *semantics* — the
 * docstring — and every parameter name it emits is checked against the real schema before
 * the line is accepted. A compiled map that invents a parameter would be worse than no map
 * at all, because the model would confidently call something that does not exist.
 */
import "dotenv/config";
import { writeFileSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { REAL_TOOLS } from "./fixtures/real.js";

const args = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const LIMIT = Number(args("limit") ?? 0);
const OUT = args("out") ?? new URL("./fixtures/python-map.json", import.meta.url).pathname;
const MODEL = args("model") ?? "claude-opus-5";
const BATCH = 12;

type Tool = { name: string; description?: string; input_schema?: any; inputSchema?: any };
const TOOLS: Tool[] = (REAL_TOOLS as any[]).map((t) => ({
  name: t.name, description: t.description, input_schema: t.input_schema,
}));
const corpus = LIMIT ? TOOLS.slice(0, LIMIT) : TOOLS;

const schemaOf = (t: Tool) => t.input_schema ?? t.inputSchema ?? {};
const paramsOf = (t: Tool) => Object.keys(schemaOf(t).properties ?? {});
const requiredOf = (t: Tool): string[] => schemaOf(t).required ?? [];

const PROMPT = `You are compressing tool definitions into minified Python for another model to read.

For each tool emit EXACTLY ONE line:

def <name>(<params>):"<docstring>"

Rules, all mandatory:
- <name> is the tool name verbatim. Never rename.
- <params> are the real parameter names. Required ones first and bare; optional ones as
  name=0. Never invent, rename, drop or reorder a required parameter.
- The docstring is the whole point. In as few characters as possible say WHAT it does and
  WHEN to reach for it instead of a similarly-named tool. If a parameter takes a fixed set
  of values, list them as k:a|b|c. Drop articles, drop pleasantries, drop restating the
  name. No period at the end.
- Aim for under 110 characters of docstring. Shorter is better if nothing is lost.
- Output only the def lines, one per tool, no fences, no commentary, no blank lines.

Example input:
  github_create_issue — "Create a new issue in a GitHub repository. Use this when the user
  wants to file a bug or request a feature." params: owner*, repo*, title*, body, labels
Example output:
  def github_create_issue(owner,repo,title,body=0,labels=0):"file bug/feature on repo; not for comments or PRs"`;

function describe(t: Tool): string {
  const req = new Set(requiredOf(t));
  const props = schemaOf(t).properties ?? {};
  const params = paramsOf(t)
    .map((p) => {
      const spec = props[p] ?? {};
      const en = Array.isArray(spec.enum) ? `:${spec.enum.join("|")}` : "";
      return `${p}${req.has(p) ? "*" : ""}${en}`;
    })
    .join(", ");
  return `${t.name} — "${(t.description ?? "").replace(/\s+/g, " ").slice(0, 600)}" params: ${params || "(none)"}`;
}

/** A line is accepted only if the model kept the real contract. */
function verify(line: string, t: Tool): string | null {
  const m = line.match(/^def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*:\s*(.+)$/);
  if (!m) return "not a single-line def";
  if (m[1] !== t.name) return `renamed the tool to ${m[1]}`;
  const emitted = m[2].split(",").map((p) => p.trim().split("=")[0].trim()).filter(Boolean);
  const real = new Set(paramsOf(t));
  const invented = emitted.filter((p) => !real.has(p));
  if (invented.length) return `invented parameter(s): ${invented.join(", ")}`;
  const missing = requiredOf(t).filter((p) => !emitted.includes(p));
  if (missing.length) return `dropped required parameter(s): ${missing.join(", ")}`;
  if (!/^".*"$/.test(m[3].trim())) return "docstring is not a single quoted string";
  return null;
}

async function main() {
  const client = new Anthropic();
  const out: Record<string, string> = {};
  const rejected: string[] = [];

  for (let i = 0; i < corpus.length; i += BATCH) {
    const batch = corpus.slice(i, i + BATCH);
    const res: any = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: PROMPT,
      messages: [{ role: "user", content: batch.map(describe).join("\n\n") }],
    });
    const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const lines = text.split("\n").map((l: string) => l.trim()).filter((l: string) => l.startsWith("def "));

    for (const t of batch) {
      const line = lines.find((l: string) => l.startsWith(`def ${t.name}(`));
      if (!line) { rejected.push(`${t.name}: no line returned`); continue; }
      const problem = verify(line, t);
      if (problem) { rejected.push(`${t.name}: ${problem}`); continue; }
      out[t.name] = line;
    }
    process.stdout.write(`  compiled ${Object.keys(out).length}/${Math.min(i + BATCH, corpus.length)}\r`);
  }

  // Retry the stragglers one at a time. A batch of 12 occasionally drops a line or
  // renames a tool; asking for one in isolation nearly always fixes it, and a tool that
  // still fails verification after a retry is simply left out rather than shipped wrong.
  const missing = corpus.filter((t) => !out[t.name]);
  if (missing.length) {
    console.log(`\n  retrying ${missing.length} individually…`);
    for (const t of missing) {
      const res: any = await client.messages.create({
        model: MODEL, max_tokens: 500, system: PROMPT,
        messages: [{ role: "user", content: describe(t) }],
      });
      const line = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
        .split("\n").map((l: string) => l.trim()).find((l: string) => l.startsWith(`def ${t.name}(`));
      const problem = line ? verify(line, t) : "no line returned";
      if (line && !problem) {
        out[t.name] = line;
        const i = rejected.findIndex((r) => r.startsWith(`${t.name}:`));
        if (i >= 0) rejected.splice(i, 1);
      }
    }
  }

  writeFileSync(OUT, JSON.stringify(out, null, 0) + "\n");
  const chars = Object.values(out).join("\n").length;
  console.log(`\nwrote ${OUT}`);
  console.log(`  ${Object.keys(out).length}/${corpus.length} tools compiled, ${chars} chars (${Math.round(chars / Object.keys(out).length)}/tool)`);
  if (rejected.length) {
    console.log(`  ${rejected.length} REJECTED by verification:`);
    for (const r of rejected.slice(0, 10)) console.log(`    ${r}`);
  }
}
main();
