import type { JsonSchema, Tool, NormalizedTool } from "../types.js";

/** JSON Schema keys that carry no information the sampler can act on. */
const DROP_KEYS = new Set([
  "description",
  "$schema",
  "title",
  "examples",
  "default",
  "additionalProperties",
  "$id",
  "$comment",
]);

/**
 * Strip prose and boilerplate from a JSON Schema while preserving everything
 * that constrains decoding: types, enums, required, item types, nesting.
 *
 * This is the single highest-leverage transform in the library — per-property
 * `description` strings are the bulk of a real MCP tool definition.
 */
export function flattenSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object") return { type: "object" };
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, any>).map(([pk, pv]) => [
          pk,
          flattenProperty(pv),
        ]),
      );
    } else if (k === "items") {
      out.items = flattenProperty(v);
    } else {
      out[k] = v;
    }
  }
  if (!out.type) out.type = "object";
  return out;
}

function flattenProperty(p: any): any {
  if (!p || typeof p !== "object") return p;
  if (Array.isArray(p)) return p.map(flattenProperty);
  const out: any = {};
  for (const [k, v] of Object.entries(p)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, any>).map(([pk, pv]) => [
          pk,
          flattenProperty(pv),
        ]),
      );
    } else if (k === "items") {
      out.items = flattenProperty(v);
    } else if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      out[k] = (v as any[]).map(flattenProperty);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * `name(required, optional?:a|b, list?:string[])`
 *
 * A model reads this natively. A 400-token JSON Schema becomes one line.
 */
export function signatureLine(tool: Tool | NormalizedTool, nameOverride?: string): string {
  const schema =
    (tool as NormalizedTool).schema ??
    (tool as Tool).inputSchema ??
    (tool as Tool).input_schema ??
    {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const parts = Object.entries(props).map(([key, raw]) => {
    const v = raw as any;
    const opt = required.has(key) ? "" : "?";
    let hint = "";
    if (v?.enum) hint = `:${v.enum.join("|")}`;
    else if (v?.type === "array" && v.items?.type) hint = `:${v.items.type}[]`;
    return `${key}${opt}${hint}`;
  });
  return `${nameOverride ?? tool.name}(${parts.join(",")})`;
}

/**
 * Aggressively shortened descriptor: first sentence, stop-words dropped,
 * lowercased. Used by the `terse` map style, which trades legibility (and the
 * real tool name) for a few tokens per line.
 */
export function terseDescriptor(s: string): string {
  return firstSentence(s)
    .replace(/\b(the|a|an|to|of|for|in|with|and|that|this)\b ?/gi, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** First sentence only — the rest is almost always restatement. */
export function firstSentence(s: string): string {
  const m = s.match(/^(.*?[.!?])(\s|$)/s);
  return (m ? m[1] : s).trim();
}

/** Cheap size proxy for stats. Not a token count — never used for billing. */
export function countSchemaTokensApprox(x: unknown): number {
  return JSON.stringify(x ?? "").length;
}

/** Default namespace split: `github_create_issue` → github / create_issue. */
export function defaultNamespaceOf(name: string): { ns: string; op: string } {
  const i = name.search(/[_.]/);
  if (i === -1) return { ns: name, op: name };
  return { ns: name.slice(0, i), op: name.slice(i + 1) };
}

export function normalize(
  tools: Tool[],
  namespaceOf: (n: string) => { ns: string; op: string },
): NormalizedTool[] {
  const seen = new Set<string>();
  const out = tools.map((t) => {
    if (!t?.name) throw new Error("tool is missing a name");
    if (seen.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    seen.add(t.name);
    // Validate the callback's return rather than trusting it. Getting this
    // contract wrong is easy — it takes a name and returns {ns, op}, not a bare
    // namespace string — and the failure was previously silent and remote: every
    // tool landed in one `undefined` group, and the first sign of trouble was the
    // provider rejecting a tool with an empty name, far from the cause.
    const parts = namespaceOf(t.name);
    const ns = parts?.ns;
    const op = parts?.op;
    if (typeof ns !== "string" || !ns || typeof op !== "string" || !op) {
      throw new Error(
        `namespaceOf("${t.name}") must return { ns, op } with non-empty strings, ` +
          `got ${JSON.stringify(parts)}. ` +
          `Example: (name) => ({ ns: serverOf(name), op: name }).`,
      );
    }
    return {
      name: t.name,
      description: t.description ?? "",
      schema: t.inputSchema ?? t.input_schema ?? { type: "object" },
      ns,
      op,
    };
  });
  // Deterministic ordering. Prefix stability is what makes prompt caching work;
  // a caller iterating a Map or Set must not silently change the cache key.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
