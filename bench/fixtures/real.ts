/**
 * Real tool definitions, harvested from live MCP servers.
 *
 * Collected by speaking MCP over stdio to each server (initialize →
 * notifications/initialized → tools/list) and recording exactly what it
 * advertised. Nothing here is authored or idealised: the descriptions, the
 * bracketed `[Financial]` prefixes, the inconsistent naming, the 51-tool server
 * — that is what a real deployment looks like.
 *
 * Why this exists: the synthetic fixture flattered at least one compression
 * style. Its `ns_op` naming gave the `grouped` map style a shared prefix on every
 * tool, worth -21% there. Real MCP tools are named `compute_route`, not
 * `google_maps_compute_route`, so measurements taken on the fixture do not
 * transfer. Anything claimed about real deployments should be measured here.
 *
 * 149 tools / 14 servers / ~68,500 uncompressed prompt tokens on claude-opus-5 —
 * about a third of a 200k context window before the user says anything.
 */
import { readFileSync } from "node:fs";
import type { ToolDef } from "../core/types.js";

type RawRealTool = {
  server: string;
  name: string;
  description: string;
  input_schema: any;
};

const RAW: RawRealTool[] = JSON.parse(
  readFileSync(new URL("./real-mcp-tools.json", import.meta.url), "utf8"),
);

/** Which MCP server advertised a given tool. */
export const SERVER_OF = new Map(RAW.map((t) => [t.name, t.server]));

/**
 * Namespace from the tool's own name, matching the library's default
 * `namespaceOf`. Deliberately not the server: the server name does not appear in
 * the tool name, so grouping by it adds a label and saves nothing (measured:
 * 2,700 tokens by-server against 2,314 by-prefix at 149 tools).
 */
function nsOp(name: string): { ns: string; op: string } {
  const i = name.search(/[_.]/);
  return i === -1 ? { ns: name, op: name } : { ns: name.slice(0, i), op: name.slice(i + 1) };
}

export const REAL_TOOLS: ToolDef[] = RAW.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
  ...nsOp(t.name),
}));

export const REAL_BY_NAME = new Map(REAL_TOOLS.map((t) => [t.name, t]));

/** Named tools, in the order given. Throws on a typo rather than silently omitting. */
export function realToolsByName(names: string[]): ToolDef[] {
  return names.map((n) => {
    const t = REAL_BY_NAME.get(n);
    if (!t) throw new Error(`no real MCP tool named "${n}"`);
    return t;
  });
}

/**
 * The whole catalogue, optionally capped. Every scenario runs against all 149
 * tools by default — that is the condition being tested, since a model choosing
 * between 149 real tools is the situation compression has to survive.
 */
export function realSubset(count = REAL_TOOLS.length, mustInclude: string[] = []): ToolDef[] {
  const picked = new Map(realToolsByName(mustInclude).map((t) => [t.name, t]));
  for (const t of REAL_TOOLS) {
    if (picked.size >= count) break;
    if (!picked.has(t.name)) picked.set(t.name, t);
  }
  return [...picked.values()].sort((a, b) => a.name.localeCompare(b.name));
}
