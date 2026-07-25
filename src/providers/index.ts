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
