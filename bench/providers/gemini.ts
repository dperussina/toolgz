/**
 * Google Gemini provider adapter for the benchmark harness.
 *
 * Translates the Anthropic-shaped `WireTool[]` / `ChatMessage[]` that every arm
 * emits into the Gemini **Interactions API** wire format and normalises the
 * response back into `ChatResult`.
 *
 * SDK: `@google/genai` (v2.13.0). Credentials come from `GEMINI_API_KEY`.
 *
 * ## Why the Interactions API and not `generateContent`
 *
 * `client.interactions.create()` is the current recommended surface;
 * `client.models.generateContent()` is the previous-generation API. The
 * differences that actually matter to this adapter:
 *
 *   - `generateContent` typed `FunctionDeclaration.parameters` as an OpenAPI
 *     3.03 Schema *subset* with UPPERCASE type enums, and hard-rejected unknown
 *     JSON Schema keywords. That forced a lossy sanitiser.
 *   - The Interactions API types the tool as `{type:"function", name,
 *     description, parameters}` where `parameters` is plain **JSON Schema**.
 *     Verified against the live API on `gemini-3.1-pro-preview` (2026-07-25):
 *     `additionalProperties`, `$schema`, `$id`, `$ref`+`$defs`, `$comment`,
 *     `default`, `example`, `examples`, `const`, `oneOf`, `allOf`, `anyOf`,
 *     `not`, `if`/`then`/`else`, `patternProperties`,
 *     `unevaluatedProperties`, `additionalItems`, `prefixItems`, `contains`,
 *     `dependentRequired`, `multipleOf`, `exclusiveMinimum`/`Maximum`,
 *     `uniqueItems`, `readOnly`/`writeOnly`, `deprecated`, union types
 *     (`["string","null"]`), and every `format` tried (`uri`, `email`, `uuid`,
 *     `date-time`, `int32`) are ALL ACCEPTED. Lowercase and uppercase `type`
 *     spellings both work.
 *
 * Pass-through matters here beyond correctness: this benchmark *measures the
 * token cost of the tool block*. The old sanitiser stripped keywords the arms
 * had deliberately emitted, so it was measuring a schema the arm never
 * produced. We now send the arm's JSON Schema essentially verbatim.
 *
 * Only two schema shapes are rejected by the live API, and both are repaired
 * below (see `prepareParameters`):
 *   1. omitting `parameters` entirely -> 400 "schema at top-level must be a
 *      boolean or an object" (it is required, even for zero-argument tools);
 *   2. `required` naming a property absent from `properties` -> 400 "schema at
 *      top-level requires unspecified property 'x'".
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  Provider,
  ToolCall,
  Usage,
  WireTool,
} from "./types.js";

/**
 * Google's current frontier / flagship model.
 *
 * Pro tier (deliberately not Flash or Flash-Lite), 1M-token input context,
 * supports function calling. Confirmed present on the live `models.list`
 * endpoint 2026-07-25 with inputTokenLimit=1048576, outputTokenLimit=65536.
 *
 * Pro-tier candidates returned by the live catalogue, and why they lose:
 *   models/gemini-3.1-pro-preview            <- SELECTED, current flagship Pro
 *   models/gemini-3.1-pro-preview-customtools   variant, not the general model
 *   models/gemini-3-pro-preview              superseded by 3.1
 *   models/gemini-2.5-pro                    previous generation
 *   models/gemini-pro-latest                 floating alias; a benchmark wants
 *                                            a pinned id for reproducibility
 *   models/gemini-3-pro-image[-preview]      image generation, 128k context
 *   models/deep-research-pro-preview-12-2025 research agent, not a base model
 *
 * There is no `gemini-3.5-pro`: the 3.5 generation currently ships Flash only
 * (`gemini-3.5-flash`), so 3.1 Pro remains the top Pro tier and is not
 * superseded.
 */
const MODEL = "gemini-3.1-pro-preview";

/**
 * Reasoning effort.
 *
 * The Anthropic arm runs at high reasoning effort, so we ask for parity. On
 * `gemini-3.1-pro-preview` the legal `thinking_level` values are "low" |
 * "medium" | "high" (there is no "minimal" on the Pro tier) and the documented
 * default is already "high" — we set it explicitly so the benchmark does not
 * silently change if Google moves the default.
 *
 * `thinking_summaries` is deliberately left off: summaries are billed output
 * text that the harness would immediately discard.
 */
const THINKING_LEVEL = "high";

/** Cheaper reasoning setting for the two token-measurement calls (see below). */
const MEASURE_THINKING_LEVEL = "low";

/**
 * Pricing verified 2026-07-25 from https://ai.google.dev/gemini-api/docs/pricing
 * (paid Standard tier, `gemini-3.1-pro-preview`):
 *
 *   input        $2.00 / 1M tokens  (prompts <= 200k;  $4.00 above)
 *   output      $12.00 / 1M tokens (prompts <= 200k; $18.00 above)
 *   cached input $0.20 / 1M tokens (prompts <= 200k;  $0.40 above)
 *
 * The harness wants $ per single token, and benchmark prompts sit far below the
 * 200k long-context threshold, so the short-context rate is the right one.
 *
 * The cache *storage* charge ($4.50 / 1M tokens / hour) is not modelled: the
 * harness has no explicit-cache lifetime to bill against, and this arm never
 * creates one.
 */
const PRICE_IN_PER_MTOK = 2.0;
const PRICE_OUT_PER_MTOK = 12.0;
const PRICE_CACHED_IN_PER_MTOK = 0.2;

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

let client: GoogleGenAI | undefined;

function ai(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set (expected in .env)");
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

// --------------------------------------------------------------------------
// Local structural types
//
// The SDK keeps its Interactions step/tool types inside an unexported
// `declare namespace interactions`, so they cannot be imported by name. These
// mirror the SDK's shapes (all snake_case on this API surface) and are cast at
// the two call sites.
// --------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };

type FunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

/** Steps we send. */
type InputStep =
  | { type: "user_input"; content: TextContent[] }
  | { type: "model_output"; content: TextContent[] }
  | { type: "thought"; signature?: string; summary?: unknown }
  | {
      type: "function_call";
      id: string;
      name: string;
      arguments: Record<string, any>;
      /** Opaque reasoning signature. Validated server-side; cannot be forged. */
      signature?: string;
    }
  | {
      type: "function_result";
      call_id: string;
      name?: string;
      is_error?: boolean;
      result: TextContent[];
    };

/** Steps we read back. Only the fields this adapter touches. */
type ResponseStep = {
  type: string;
  id?: string;
  name?: string;
  arguments?: Record<string, any>;
  content?: Array<{ type?: string; text?: string }>;
  error?: { code?: number; message?: string };
};

type ResponseUsage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_cached_tokens?: number;
  total_tool_use_tokens?: number;
  total_tokens?: number;
};

type InteractionResponse = {
  status?: string;
  steps?: ResponseStep[];
  usage?: ResponseUsage;
};

/**
 * Step types the model produces. Used both to pick the generated tail out of a
 * response and to decide what may be replayed verbatim as history.
 */
const MODEL_STEP_TYPES = new Set([
  "thought",
  "model_output",
  "function_call",
  "google_search_call",
  "google_search_result",
  "code_execution_call",
  "code_execution_result",
  "url_context_call",
  "url_context_result",
  "file_search_call",
  "file_search_result",
  "mcp_server_tool_call",
  "mcp_server_tool_result",
]);

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursively drop `required` entries that name a property absent from the
 * sibling `properties` map. This is the one schema repair the live API forces
 * on us (it 400s otherwise), and it is deliberately the *only* transformation
 * applied — everything else is passed through so the measured token cost is the
 * arm's actual schema.
 */
function fixRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(fixRequired);
  if (!isPlainObject(node)) return node;

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === "required" ? value : fixRequired(value);
  }

  if (Array.isArray(out.required) && isPlainObject(out.properties)) {
    const known = new Set(Object.keys(out.properties));
    const kept = out.required.filter((r: unknown) => typeof r === "string" && known.has(r));
    if (kept.length > 0) out.required = kept;
    else delete out.required;
  } else if (Array.isArray(out.required) && out.properties === undefined) {
    // No property map to validate against; the API rejects every name.
    delete out.required;
  }

  return out;
}

/**
 * `parameters` is REQUIRED on this API — omitting it 400s with "schema at
 * top-level must be a boolean or an object" even for a zero-argument tool — so
 * fall back to an empty object schema, which the API does accept.
 */
function prepareParameters(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) return { type: "object", properties: {} };
  const fixed = fixRequired(schema) as Record<string, unknown>;
  if (Object.keys(fixed).length === 0) return { type: "object", properties: {} };
  return fixed;
}

/** Anthropic-shaped tools -> Interactions `function` tool declarations. */
function toTools(tools: WireTool[]): FunctionTool[] {
  return tools.map((tool) => {
    const decl: FunctionTool = {
      type: "function",
      name: tool.name,
      parameters: prepareParameters(tool.input_schema),
    };
    if (tool.description) decl.description = tool.description;
    return decl;
  });
}

// --------------------------------------------------------------------------
// Messages -> input steps
// --------------------------------------------------------------------------

/**
 * The harness is stateless: it hands us the whole conversation every turn. We
 * therefore replay history as an explicit `input` step array rather than using
 * `previous_interaction_id`, which keeps this adapter's accounting identical to
 * the other providers (all of which resend full history) and lets us set
 * `store: false`.
 *
 * Gemini 3.x reasoning state is an opaque `signature` carried ON THE
 * `function_call` step itself (observed step keys: id, signature, type, name,
 * arguments), and on any `thought` step. The server cryptographically validates
 * it — verified against the live API:
 *
 *   real id + real signature      -> 200 OK
 *   real id, signature removed    -> 400 "Request contains an invalid argument."
 *   real id, signature = garbage  -> 400 "Corrupted thought signature."
 *   fabricated id + real signature-> 200 OK   (the id itself is NOT validated)
 *
 * So a `function_call` step CANNOT be synthesised — it must be replayed
 * verbatim. `ChatMessage.raw` exists precisely for this and the harness always
 * populates it, which is the path taken in practice.
 *
 * The fallback, for an assistant turn that arrives without `raw`, therefore
 * must NOT emit `function_call` / `function_result` steps at all; forging one
 * is a guaranteed 400. Instead the exchange is degraded to a plain-text
 * transcript, which the API accepts and the model understands (verified: the
 * narrative form still produced the correct final answer). Reasoning
 * continuity is lost on that path, but the run does not crash.
 */
function toInputSteps(messages: ChatMessage[]): InputStep[] {
  const steps: InputStep[] = [];
  // Whether the most recent assistant turn was replayed as native steps. If it
  // was not, its tool results must also be narrated, because a `function_result`
  // step with no matching `function_call` confuses the model.
  let lastAssistantWasNative = true;

  for (const msg of messages) {
    if (msg.role === "user") {
      steps.push({ type: "user_input", content: [{ type: "text", text: msg.content }] });
      continue;
    }

    if (msg.role === "assistant") {
      // Preferred path: replay the provider-native steps verbatim, preserving
      // the reasoning signatures without which the API rejects the request.
      const replay = Array.isArray(msg.raw)
        ? (msg.raw as ResponseStep[]).filter(
            (s) =>
              isPlainObject(s) && typeof s.type === "string" && MODEL_STEP_TYPES.has(s.type),
          )
        : [];
      if (replay.length > 0) {
        steps.push(...(replay as unknown as InputStep[]));
        lastAssistantWasNative = true;
        continue;
      }

      // Fallback: narrate. Reasoning state is lost, but nothing is forged.
      lastAssistantWasNative = false;
      const lines: string[] = [];
      if (msg.text) lines.push(msg.text);
      for (const call of msg.toolCalls ?? []) {
        lines.push(`[tool_call] ${call.name}(${safeJson(call.args ?? {})})`);
      }
      if (lines.length > 0) {
        steps.push({ type: "model_output", content: [{ type: "text", text: lines.join("\n") }] });
      }
      continue;
    }

    const results = msg.results ?? [];
    if (results.length === 0) continue;

    if (!lastAssistantWasNative) {
      const lines = results.map(
        (r) => `[${r.isError ? "tool_error" : "tool_result"}] ${r.name}: ${r.content}`,
      );
      steps.push({ type: "user_input", content: [{ type: "text", text: lines.join("\n") }] });
      continue;
    }

    // tool_results -> one function_result step each. `call_id` echoes the id the
    // API assigned to the function_call step. `name` is required in practice:
    // omitting it returns 400 "Invalid input received.", despite the SDK typing
    // it optional.
    for (const result of results) {
      const step: InputStep = {
        type: "function_result",
        call_id: result.id,
        name: result.name,
        result: [{ type: "text", text: result.content }],
      };
      if (result.isError) step.is_error = true;
      steps.push(step);
    }
  }

  return steps;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** `system` then `systemPreamble`, blank line between. Preamble omitted if empty. */
function buildSystemInstruction(
  system: string,
  systemPreamble: string,
): string | undefined {
  const chunks: string[] = [];
  if (system && system.trim().length > 0) chunks.push(system);
  if (systemPreamble && systemPreamble.trim().length > 0) chunks.push(systemPreamble);
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

// --------------------------------------------------------------------------
// Response normalisation
// --------------------------------------------------------------------------

/**
 * The Interactions API has no per-candidate `finishReason`. Completion state
 * comes from `Interaction.status`, and content-level problems arrive as an
 * `error` on the `model_output` step.
 */
function normaliseStopReason(
  res: InteractionResponse,
  generated: ResponseStep[],
  hasToolCalls: boolean,
): string {
  if (hasToolCalls) return "tool_use";

  const errored = generated.find((s) => s.type === "model_output" && s.error);
  if (errored) return "refusal";

  switch (res.status) {
    case "completed":
      return "end_turn";
    // Output budget exhausted before the model finished.
    case "incomplete":
    case "budget_exceeded":
      return "max_tokens";
    case "failed":
    case "cancelled":
      return "refusal";
    default:
      return res.status ?? "end_turn";
  }
}

/**
 * Usage field names differ from `generateContent`'s `usageMetadata`:
 *
 *   promptTokenCount         -> total_input_tokens
 *   candidatesTokenCount     -> total_output_tokens
 *   thoughtsTokenCount       -> total_thought_tokens
 *   cachedContentTokenCount  -> total_cached_tokens
 *   (new)                    -> total_tool_use_tokens, total_tokens
 *
 * Verified on the live API that `total_output_tokens` EXCLUDES thinking, i.e.
 * total_tokens == total_input_tokens + total_output_tokens +
 * total_thought_tokens (observed 245 == 102 + 4 + 139). Thinking is billed at
 * the output rate, so it is folded into `outputTokens` for costing.
 */
function normaliseUsage(res: InteractionResponse): Usage {
  const u = res.usage;
  return {
    promptTokens: u?.total_input_tokens ?? 0,
    outputTokens: (u?.total_output_tokens ?? 0) + (u?.total_thought_tokens ?? 0),
    cachedTokens: u?.total_cached_tokens ?? 0,
  };
}

function normaliseResponse(res: InteractionResponse): ChatResult {
  // `steps` can echo the replayed history, so keep only the model-produced
  // tail: everything after the last step we supplied.
  const all = res.steps ?? [];
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const t = all[i]?.type;
    if (t === "user_input" || t === "function_result") {
      start = i + 1;
      break;
    }
  }
  const generated = all.slice(start).filter((s) => MODEL_STEP_TYPES.has(s.type));

  const toolCalls: ToolCall[] = [];
  let text = "";

  for (const step of generated) {
    if (step.type === "model_output") {
      for (const block of step.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") text += block.text;
      }
    } else if (step.type === "function_call") {
      toolCalls.push({
        id: step.id ?? `${step.name ?? "call"}-${toolCalls.length}`,
        name: step.name ?? "",
        args: step.arguments ?? {},
      });
    }
    // `thought` steps are reasoning, not answer text. They are not read here
    // but ARE carried in `raw` so they can be replayed with their signatures.
  }

  return {
    toolCalls,
    text,
    usage: normaliseUsage(res),
    stopReason: normaliseStopReason(res, generated, toolCalls.length > 0),
    // Round-tripped verbatim by the harness as `ChatMessage.raw`.
    raw: generated,
  };
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

/** Smallest legal prompt, used as the constant baseline when measuring. */
const PROBE_INPUT = "x";

/**
 * Output cap for the two measurement calls. Only the input token count is read,
 * so this just needs to be small; it is not squeezed to 1 because Gemini 3 Pro
 * always thinks and a too-tight cap can fail the request outright.
 */
const MEASURE_MAX_TOKENS = 256;

export const geminiProvider: Provider = {
  id: "gemini",
  model: MODEL,
  priceIn: PRICE_IN_PER_MTOK / 1_000_000,
  priceOut: PRICE_OUT_PER_MTOK / 1_000_000,
  priceCachedIn: PRICE_CACHED_IN_PER_MTOK / 1_000_000,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const tools = toTools(req.tools);

    const res = (await ai().interactions.create({
      model: MODEL,
      input: toInputSteps(req.messages) as never,
      ...(tools.length > 0 ? { tools: tools as never } : {}),
      system_instruction: buildSystemInstruction(req.system, req.systemPreamble),
      // History is replayed explicitly every turn, so nothing needs to be
      // retained server-side.
      store: false,
      generation_config: {
        max_output_tokens: req.maxTokens,
        thinking_level: THINKING_LEVEL,
        // tool_choice is left at its "auto" default: which tools the model
        // picks, and whether it picks any, is exactly what the benchmark
        // measures, so it must not be forced.
      },
    })) as InteractionResponse;

    return normaliseResponse(res);
  },

  /**
   * Prompt tokens attributable to the tool block + preamble.
   *
   * METHOD USED: measurement by difference against two real
   * `interactions.create` calls, subtracting the reported
   * `usage.total_input_tokens`. Verified to move with the tool block (102 input
   * tokens with a one-tool block vs 2 bare, on the same one-character probe).
   *
   * The dedicated `models.countTokens` endpoint is NOT used, for two reasons:
   *
   *  1. It cannot see the system instruction on the Gemini Developer API. The
   *     SDK rejects it client-side (verified against @google/genai v2.13.0):
   *       "systemInstruction parameter is only supported in Gemini Enterprise
   *        Agent Platform mode, not in Gemini Developer API mode."
   *  2. Even if that were lifted, countTokens serialises the *legacy*
   *     `generateContent` tool format, not the Interactions tool format we
   *     actually bill on — so it would answer a different question than the one
   *     this benchmark asks.
   *
   * Measurement by difference costs a little money, which is why the harness
   * calls this once per (arm, scenario) rather than per run. Both calls use the
   * same fixed one-character probe prompt, so the probe and any fixed
   * scaffolding cancel out and only the tools + preamble remain.
   */
  async measureToolBlock(tools: WireTool[], systemPreamble: string): Promise<number> {
    const declarations = toTools(tools);
    const systemInstruction = buildSystemInstruction("", systemPreamble);
    const generationConfig = {
      max_output_tokens: MEASURE_MAX_TOKENS,
      thinking_level: MEASURE_THINKING_LEVEL,
    };

    const [loaded, bare] = (await Promise.all([
      ai().interactions.create({
        model: MODEL,
        input: PROBE_INPUT,
        ...(declarations.length > 0 ? { tools: declarations as never } : {}),
        system_instruction: systemInstruction,
        store: false,
        generation_config: generationConfig,
      }),
      ai().interactions.create({
        model: MODEL,
        input: PROBE_INPUT,
        store: false,
        generation_config: generationConfig,
      }),
    ])) as [InteractionResponse, InteractionResponse];

    const delta =
      (loaded.usage?.total_input_tokens ?? 0) - (bare.usage?.total_input_tokens ?? 0);
    return Math.max(0, delta);
  },
};

export default geminiProvider;
