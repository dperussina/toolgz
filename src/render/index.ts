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
    // Validate the callback's return rather than trusting it. The contract is
    // easy to get wrong — it takes a name and returns {ns, op}, not a bare
    // namespace string — and the failure was silent and remote: every tool
    // collapsed into one `undefined` namespace, level 2 emitted a wire tool with
    // an empty name, and the first symptom was the provider rejecting the request
    // with "tools.0.custom.name: Field required", nowhere near the cause.
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

// ── experimental: tools as TypeScript ────────────────────────────────────────
/**
 * Render a JSON Schema property as a TypeScript type.
 *
 * Enums become string-literal unions, which is the point of the experiment: a union is
 * how a model has seen "one of these exact values" expressed a million times, and it is
 * shorter than the `a|b|c` hint our map styles use once quoting is accounted for.
 */
export function tsType(spec: any): string {
  if (!spec || typeof spec !== "object") return "unknown";
  if (Array.isArray(spec.enum) && spec.enum.length) {
    return spec.enum
      .map((v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
      .join(" | ");
  }
  const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
  switch (type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `${tsType(spec.items ?? {})}[]`;
    case "object": {
      const props = spec.properties;
      if (!props || typeof props !== "object") return "Record<string, unknown>";
      const inner = Object.entries(props as Record<string, any>)
        .map(([k, v]) => `${k}${(spec.required ?? []).includes(k) ? "" : "?"}: ${tsType(v)}`)
        .join("; ");
      return `{ ${inner} }`;
    }
    default: return "unknown";
  }
}

/** `create_issue(owner: string, repo: string, body?: string): void` */
export function tsSignature(tool: NormalizedTool, name = tool.op): string {
  const schema = tool.schema ?? {};
  const props: Record<string, any> = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  // Required first, so a reader scanning left to right meets the mandatory arguments
  // before the optional tail — and so the shape matches a real function signature,
  // where an optional parameter cannot precede a required one.
  const keys = Object.keys(props).sort(
    (a, b) => Number(required.has(b)) - Number(required.has(a)),
  );
  const params = keys
    .map((k) => `${k}${required.has(k) ? "" : "?"}: ${tsType(props[k])}`)
    .join(", ");
  return `${name}(${params}): void`;
}

/**
 * The whole catalogue as a `.d.ts`, grouped into namespaces.
 *
 * The hypothesis: a model reads a typed function signature more reliably than a
 * positional map line, because it has enormous priors for one and none for the other.
 * Worth testing specifically because an external registry showed that when a map is
 * ambiguous, legibility beats size — `mapStyle: "signature"` cost 4x the tokens of
 * `name+required` and took wrong picks from 3/3 to 0/3.
 *
 * `withDocs` adds a one-line JSDoc per function. That is the "purpose hint" idea we
 * disqualified in 0.2.0 as `terse`, measured on a corpus of uniquely-named verb-first
 * tools that never exhibited the ambiguity this is meant to address. Code comments are
 * the form a model is most used to seeing it in.
 */
export function tsModule(
  byNamespace: Map<string, NormalizedTool[]>,
  withDocs: boolean,
): string {
  const out: string[] = [];
  for (const [ns, tools] of byNamespace) {
    out.push(`declare namespace ${tsIdent(ns)} {`);
    for (const t of tools) {
      if (withDocs) {
        const d = firstSentence(t.description ?? "").trim();
        if (d) out.push(`  /** ${d.replace(/\*\//g, "*\\/")} */`);
      }
      out.push(`  function ${tsSignature(t, tsIdent(t.op))};`);
    }
    out.push(`}`);
  }
  return out.join("\n");
}

/** Namespaces and operations come from tool names, which are not always identifiers. */
function tsIdent(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
