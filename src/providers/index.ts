/**
 * Provider adapters.
 *
 * The core emits Anthropic-shaped tool definitions because that is the shape
 * MCP and most SDKs already produce. These adapters reshape for other
 * providers and place cache breakpoints where each provider expects them.
 *
 * Adapters are pure functions. They make no network calls.
 */
import type { CompressResult } from "../types.js";

export type CacheTtl = "5m" | "1h";

/**
 * Anthropic: `tools` render before `system`, which renders before `messages`.
 * A breakpoint on the last tool caches the whole tool block.
 *
 * Two constraints the API enforces:
 *  - `cache_control` is rejected on a tool carrying `defer_loading`
 *  - the minimum cacheable prefix is model-dependent (512 tokens on Opus 5,
 *    1024 on Sonnet 5); below it the marker is silently ignored
 */
export function forAnthropic(
  c: CompressResult,
  opts: { cache?: boolean; ttl?: CacheTtl } = {},
): { tools: any[]; system: any } {
  const cache = opts.cache ?? true;
  const cacheControl = { type: "ephemeral" as const, ...(opts.ttl ? { ttl: opts.ttl } : {}) };

  const tools = (c.tools as any[]).map((t) => ({ ...t }));
  if (cache && tools.length) {
    // Last tool that can legally carry a breakpoint.
    for (let i = tools.length - 1; i >= 0; i--) {
      if (!tools[i].defer_loading && !String(tools[i].type ?? "").startsWith("tool_search_")) {
        tools[i].cache_control = cacheControl;
        break;
      }
    }
  }

  const system = c.systemPreamble
    ? [
        {
          type: "text",
          text: c.systemPreamble,
          ...(cache && c.cachePreamble ? { cache_control: cacheControl } : {}),
        },
      ]
    : undefined;

  return { tools, system };
}

/**
 * OpenAI: tools are `{type:"function", function:{name, description, parameters}}`.
 * Prefix caching is automatic with a 1024-token floor — there is no breakpoint
 * to place, so `systemPreamble` is returned for the caller to prepend to their
 * own system message.
 */
export function forOpenAI(c: CompressResult): {
  tools: any[];
  systemPreamble: string;
} {
  const tools = (c.tools as any[])
    .filter((t) => !String(t.type ?? "").startsWith("tool_search_"))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  return { tools, systemPreamble: c.systemPreamble };
}

/**
 * OpenAI `/v1/responses` — the endpoint you need if you want tools *and*
 * reasoning.
 *
 * The tool shape here is **flat**: `{type, name, description, parameters}`,
 * with no `function:` envelope. This is not cosmetic — on the GPT-5.x line,
 * `/v1/chat/completions` rejects function tools combined with reasoning
 * ("To use function tools, use /v1/responses or set reasoning_effort to
 * 'none'"), so a reasoning agent must be on this endpoint, and sending the
 * nested chat-completions shape here is invalid.
 *
 * Reasoning effort is a request field (`reasoning: { effort }`), not something
 * this adapter sets — it is yours to choose.
 */
export function forOpenAIResponses(c: CompressResult): {
  tools: { type: "function"; name: string; description?: string; parameters?: any }[];
  systemPreamble: string;
} {
  const tools = (c.tools as any[])
    .filter((t) => !String(t.type ?? "").startsWith("tool_search_"))
    .map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  return { tools, systemPreamble: c.systemPreamble };
}

/**
 * Google Gemini: a single `functionDeclarations` array. Gemini rejects
 * several JSON Schema keywords, so unknown keys are dropped rather than
 * passed through.
 */
export function forGemini(c: CompressResult): {
  tools: any[];
  systemPreamble: string;
} {
  const clean = (s: any): any => {
    if (!s || typeof s !== "object") return s;
    const out: any = {};
    for (const [k, v] of Object.entries(s)) {
      if (["additionalProperties", "$schema", "default", "examples"].includes(k)) continue;
      out[k] =
        k === "properties"
          ? Object.fromEntries(Object.entries(v as any).map(([pk, pv]) => [pk, clean(pv)]))
          : k === "items"
            ? clean(v)
            : v;
    }
    // Gemini rejects an array without `items`, and rejects the WHOLE request:
    //   400 GenerateContentRequest.tools[0].function_declarations[4]
    //       .parameters.properties[shipments].items: missing field
    //
    // Real MCP servers ship these — 7 of the 149 tools in bench/fixtures have an
    // untyped array parameter (analyze_consolidation.shipments,
    // compute_route.intermediates, optimize_waypoints.waypoints among them). One such
    // tool anywhere in the catalogue used to fail every Gemini call.
    //
    // `items: {}` is what Gemini accepts and is the only honest repair: the source
    // schema does not say what the items are, so we do not invent a type. Guessing
    // `{type:"string"}` would also be accepted and would make the model send strings
    // where the real API may want objects — a silent wrong-data bug in place of a loud
    // rejection. Verified empirically: omitted is rejected; `{}`, `{type:"string"}` and
    // `{type:"object"}` are all accepted.
    // JSON Schema permits a union type (`"type": ["string","array"]`, as
    // send_email_with_attachments.cc uses). Gemini requires a single type string and
    // rejects the whole request otherwise. Take the first — deterministic, and the
    // prompt-cache prefix must be byte-stable — and drop `items` if the pick is not an
    // array, where it would be meaningless.
    //
    // Narrowing is safe because the ORIGINAL schema still accepts the narrowed form, so
    // a value the model sends against it remains valid; validateArgs checks against
    // that original before dispatch.
    if (Array.isArray(out.type)) {
      out.type = out.type[0];
      if (out.type !== "array") delete out.items;
    }
    if (out.type === "array" && out.items === undefined) out.items = {};

    // Gemini accepts `enum` only on strings, and rejects the whole request otherwise:
    //   400 Invalid value at tools[0].function_declarations[30].parameters.properties[2]
    // Real MCP servers ship numeric enums — deep_research.depth is
    // {type:"number", enum:[1,2,3]}. Verified: string+enum accepted, number+enum and
    // integer+enum rejected, `oneOf` accepted (so it needs no repair).
    //
    // We drop the enum and keep the type. The constraint is not lost: validateArgs
    // checks arguments against the ORIGINAL schema before dispatch at every level, so
    // an out-of-range value is still caught — the check moves from provider-side to
    // library-side. Coercing to a string enum instead would make the model send "1"
    // where the API wants 1, which is a silent type error rather than a caught one.
    if (out.enum && out.type && out.type !== "string") delete out.enum;
    return out;
  };

  const functionDeclarations = (c.tools as any[])
    .filter((t) => !String(t.type ?? "").startsWith("tool_search_"))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: clean(t.input_schema),
    }));

  return { tools: [{ functionDeclarations }], systemPreamble: c.systemPreamble };
}
