/**
 * Compile a tool corpus into minified Python, using a model the caller brings.
 *
 * The library never imports an SDK and never sees a key: you pass a `complete` function
 * that takes a system/user pair and returns text. Any provider, any client, any auth.
 * Zero runtime dependencies is preserved because the dependency is yours, not ours.
 *
 * What the library contributes is the part worth centralising — the prompt, the batching,
 * the retry, and above all the **verification**. A compiled map that renames a tool or
 * invents a parameter is worse than no map at all: the model would confidently call
 * something that does not exist, and the failure would surface as a wrong dispatch rather
 * than an error. So every line a model returns is checked against the real schema before
 * it is accepted, and anything that fails is discarded rather than shipped.
 */
import type { Tool } from "./types.js";
import { normalize, defaultNamespaceOf } from "./render/index.js";

/**
 * Bring your own model. Return the assistant's text; throw to abort compilation.
 *
 * Note on the parameter convention the prompt enforces: optional parameters are written
 * `name=None`, never `name=0`. The first draft used `=0` and every provider read it as a
 * type declaration — three of four sent `latest_snapshot_only: 1` for a boolean and were
 * rejected by validation. A default value in a signature is information whether you meant
 * it or not.
 */
export type Completion = (input: { system: string; user: string }) => Promise<string>;

export type CompileOptions = {
  complete: Completion;
  /** Tools per request. Smaller is more reliable and more expensive. Default 12. */
  batchSize?: number;
  /** Retry tools that failed verification, one at a time. Default true. */
  retryFailures?: boolean;
  /** Target docstring length, in characters. Advisory to the model. Default 110. */
  maxDocChars?: number;
  onProgress?: (done: number, total: number) => void;
};

export type CompileResult = {
  /** Real tool name → one line of Python. Pass to `compress(tools, { compiled })`. */
  compiled: Record<string, string>;
  /** Tools that did not survive verification, and why. Never silently dropped. */
  rejected: { name: string; reason: string }[];
  /**
   * Docstrings that appear to point the model at a tool that is not in this corpus.
   *
   * Advisory, not fatal. Found on a real run: `profile_file` compiled to
   * "…profile of CSV/JSON before execute_coding_task", and `execute_coding_task` was not
   * among the tools compiled — so the map would send the model after something it does
   * not have. The source description mentioned a tool from a wider registry and the
   * compiler carried it faithfully.
   *
   * Heuristic, so it reports rather than rejects: docstrings legitimately mention column
   * names and parameters that look like tool names, and discarding a good line over a
   * false positive costs more than it saves. Review these before shipping a map.
   */
  danglingReferences: { name: string; mentions: string }[];
  stats: { total: number; compiled: number; chars: number; charsPerTool: number };
};

export const COMPILE_SYSTEM_PROMPT = (maxDocChars: number) =>
  `You are compressing tool definitions into minified Python for another model to read.

For each tool emit EXACTLY ONE line:

def <name>(<params>):"<docstring>"

Rules, all mandatory:
- <name> is the tool name verbatim. Never rename.
- <params> are the real parameter names. Required ones first and bare; optional ones as
  name=None. Never invent, rename, drop or reorder a required parameter. Use None and
  never 0 — a numeric default tells the reader the parameter is a number.
- The docstring is the whole point. In as few characters as possible say WHAT it does and
  WHEN to reach for it instead of a similarly-named tool. If a parameter takes a fixed set
  of values, list them as k:a|b|c. Drop articles, drop pleasantries, drop restating the
  name. No period at the end.
- Aim for under ${maxDocChars} characters of docstring. Shorter is better if nothing is lost.
- Output only the def lines, one per tool, no fences, no commentary, no blank lines.

Example input:
  github_create_issue — "Create a new issue in a GitHub repository. Use this when the user
  wants to file a bug or request a feature." params: owner*, repo*, title*, body, labels
Example output:
  def github_create_issue(owner,repo,title,body=None,labels=None):"file bug/feature on repo; not for comments or PRs"`;

import type { NormalizedTool } from "./types.js";

type Normalized = NormalizedTool;

/** How a tool is presented to the compiling model: contract first, prose second. */
export function describeForCompile(t: Normalized): string {
  const props: Record<string, any> = t.schema.properties ?? {};
  const required = new Set<string>(t.schema.required ?? []);
  const params = Object.keys(props)
    .map((p) => {
      const spec = props[p] ?? {};
      const en = Array.isArray(spec.enum) ? `:${spec.enum.join("|")}` : "";
      return `${p}${required.has(p) ? "*" : ""}${en}`;
    })
    .join(", ");
  const prose = (t.description ?? "").replace(/\s+/g, " ").slice(0, 600);
  return `${t.name} — "${prose}" params: ${params || "(none)"}`;
}

/**
 * Reject anything that would misrepresent the tool.
 *
 * Returns null when the line is safe to ship, or a human-readable reason. Exported so a
 * caller who compiles their own way can still get the safety check.
 */
export function verifyCompiledLine(line: string, tool: Tool | Normalized): string | null {
  const schema: any =
    (tool as Normalized).schema ?? (tool as Tool).inputSchema ?? (tool as Tool).input_schema ?? {};
  const real = new Set(Object.keys(schema.properties ?? {}));
  const required: string[] = schema.required ?? [];

  const m = line.match(/^def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*:\s*(.+)$/);
  if (!m) return "not a single-line def";
  if (m[1] !== tool.name) return `renamed the tool to ${m[1]}`;

  const emitted = m[2]
    .split(",")
    .map((p) => p.trim().split("=")[0].trim())
    .filter(Boolean);
  const invented = emitted.filter((p) => !real.has(p));
  if (invented.length) return `invented parameter(s): ${invented.join(", ")}`;
  const missing = required.filter((p) => !emitted.includes(p));
  if (missing.length) return `dropped required parameter(s): ${missing.join(", ")}`;
  if (!/^".*"$/.test(m[3].trim())) return "docstring is not a single quoted string";
  return null;
}

export async function compileTools(
  tools: Tool[],
  options: CompileOptions,
): Promise<CompileResult> {
  const {
    complete,
    batchSize = 12,
    retryFailures = true,
    maxDocChars = 110,
    onProgress,
  } = options;
  if (typeof complete !== "function") {
    throw new Error("compileTools requires a `complete` function — bring your own model client");
  }

  // Namespacing is irrelevant to compilation; normalize() is used only for its schema
  // and description normalisation, so the default splitter is fine.
  const corpus = normalize(tools, defaultNamespaceOf);
  const system = COMPILE_SYSTEM_PROMPT(maxDocChars);
  const compiled: Record<string, string> = {};
  const reasons = new Map<string, string>();

  const take = (batch: Normalized[], text: string) => {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("def "));
    for (const t of batch) {
      const line = lines.find((l) => l.startsWith(`def ${t.name}(`));
      if (!line) {
        reasons.set(t.name, "no line returned");
        continue;
      }
      const problem = verifyCompiledLine(line, t);
      if (problem) reasons.set(t.name, problem);
      else {
        compiled[t.name] = line;
        reasons.delete(t.name);
      }
    }
  };

  for (let i = 0; i < corpus.length; i += batchSize) {
    const batch = corpus.slice(i, i + batchSize);
    take(batch, await complete({ system, user: batch.map(describeForCompile).join("\n\n") }));
    onProgress?.(Object.keys(compiled).length, corpus.length);
  }

  // A batch occasionally drops or renames one line; asking for it alone nearly always
  // fixes it. Anything that still fails is left out, never shipped unverified.
  if (retryFailures) {
    for (const t of corpus.filter((t) => !compiled[t.name])) {
      take([t], await complete({ system, user: describeForCompile(t) }));
      onProgress?.(Object.keys(compiled).length, corpus.length);
    }
  }

  // Redirect phrases only — "use X", "instead of X", "before X". A bare underscored
  // token is far more often a column or a parameter than a tool.
  const known = new Set(corpus.map((t) => t.name));
  const danglingReferences: { name: string; mentions: string }[] = [];
  for (const [name, line] of Object.entries(compiled)) {
    const doc = line.slice(line.indexOf('):"') + 3, -1);
    const own = new Set(Object.keys(corpus.find((t) => t.name === name)?.schema.properties ?? {}));
    const hits = new Set<string>();
    for (const m of doc.matchAll(
      /\b(?:use|using|prefer|instead of|rather than|than|before|after|see|via|twin of)\s+([a-z][a-z0-9]*(?:_[a-z0-9]+)+)/gi,
    )) {
      const tok = m[1];
      if (tok === name || own.has(tok) || known.has(tok)) continue;
      hits.add(tok);
    }
    if (hits.size) danglingReferences.push({ name, mentions: [...hits].join(", ") });
  }

  const chars = Object.values(compiled).join("\n").length;
  const count = Object.keys(compiled).length;
  return {
    compiled,
    rejected: [...reasons].map(([name, reason]) => ({ name, reason })),
    danglingReferences,
    stats: {
      total: corpus.length,
      compiled: count,
      chars,
      charsPerTool: count ? Math.round(chars / count) : 0,
    },
  };
}
