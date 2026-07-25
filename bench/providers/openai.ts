/**
 * OpenAI provider adapter for the benchmark harness.
 *
 * Translates the Anthropic-shaped wire format the arms emit
 * (`{name, description, input_schema}`) into OpenAI's Chat Completions
 * function-tool format, and normalises the response back into `ChatResult`.
 *
 * ---------------------------------------------------------------------------
 * MODEL CHOICE
 * ---------------------------------------------------------------------------
 * `gpt-5.6-sol` — OpenAI's current frontier / flagship reasoning model,
 * selected by querying `client.models.list()` live rather than from memory.
 * In the 5.6 naming scheme the number is the generation and the suffix is the
 * capability tier: Sol (flagship) > Terra (balanced) > Luna (cheap). Sol is
 * the only tier that unlocks max reasoning effort. The `*-pro` models
 * (gpt-5.5-pro etc.) are a previous generation and are Responses-API oriented,
 * and the `-codex` variants are task-specialised, so neither is the right
 * general-purpose flagship for a tool-calling benchmark.
 *
 * ---------------------------------------------------------------------------
 * API QUIRKS HANDLED (all verified against the live API, not assumed)
 * ---------------------------------------------------------------------------
 * 1. `max_tokens` is REJECTED with HTTP 400:
 *      "Unsupported parameter: 'max_tokens' is not supported with this model.
 *       Use 'max_completion_tokens' instead."
 *    We therefore send `max_completion_tokens`. Note that this budget covers
 *    *reasoning* tokens as well as visible output tokens.
 *
 * 2. `temperature` is REJECTED for any value other than the default:
 *      "Unsupported value: 'temperature' does not support 0 with this model.
 *       Only the default (1) value is supported."
 *    We never send `temperature` at all.
 *
 * 3. `reasoning_effort` accepts 'none' | 'low' | 'medium' | 'high' | 'xhigh'.
 *    'minimal' (valid on the GPT-5.0 generation) is REJECTED.
 *
 * 4. *** THE BIG ONE ***  On /v1/chat/completions, function tools and
 *    reasoning are mutually exclusive for the entire GPT-5.x line:
 *      "Function tools with reasoning_effort are not supported for
 *       gpt-5.6-sol in /v1/chat/completions. To use function tools, use
 *       /v1/responses or set reasoning_effort to 'none'."
 *    Verified to reproduce on gpt-5.6-sol, gpt-5.6-terra, gpt-5.5 and gpt-5.4,
 *    at default effort and at 'high'. Only `reasoning_effort: "none"` is
 *    accepted alongside tools. We therefore FORCE `reasoning_effort: "none"`
 *    on every request that carries a tool block, and only honour the optional
 *    OPENAI_REASONING_EFFORT pin on tool-free turns.
 *    Consequence to report alongside any benchmark run: the OpenAI arm is
 *    measured with reasoning disabled, while the Anthropic arm pins
 *    `output_config.effort: "high"`. That is a real confound. Lifting it
 *    requires porting this adapter to /v1/responses, which uses a different
 *    tool shape (flat `{type,name,parameters}`, no nested `function:` object)
 *    than the one this harness specifies.
 *
 * 5. `max_completion_tokens: 1` raises HTTP 400 ("Could not finish the message
 *    because max_tokens or model output limit was reached"). Anything >= ~16
 *    is safe and simply returns `finish_reason: "length"` instead of throwing,
 *    so the measurement probes use a floor of 16.
 *
 * 6. Automatic prefix caching is reported at
 *    `usage.prompt_tokens_details.cached_tokens` and is *included* in
 *    `usage.prompt_tokens` — which matches this harness's `Usage` contract.
 *
 * 7. `gpt-5.6-sol` is chat-capable; the `*-pro` tiers (e.g. gpt-5.5-pro) 404 on
 *    /v1/chat/completions ("This is not a chat model"), another reason they are
 *    not the right pick here.
 */

import "dotenv/config";
import OpenAI from "openai";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  Provider,
  ToolCall,
  Usage,
  WireTool,
} from "./types.js";

type ChatCompletionMessageParam =
  OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionFunctionTool =
  OpenAI.Chat.Completions.ChatCompletionFunctionTool;
type ReasoningEffort = OpenAI.Chat.Completions.ChatCompletionReasoningEffort;

/** Frontier / flagship tier of the current generation. See MODEL CHOICE above. */
const MODEL = "gpt-5.6-sol";

/**
 * Pricing verified 2026-07-25 against OpenAI's published API pricing page
 * (platform.openai.com/docs/pricing -> developers.openai.com/api/docs/pricing):
 *   gpt-5.6-sol  $5.00 / 1M input, $0.50 / 1M cached input, $30.00 / 1M output.
 * The Provider interface wants $ per single token, so divide by 1e6.
 */
const PRICE_IN_PER_MTOK = 5.0;
const PRICE_OUT_PER_MTOK = 30.0;
/** Cached input bills at 10% of input. Not part of the Provider interface, but
 *  exported so cost models that care about prefix caching can use it. */
export const OPENAI_PRICE_CACHED_IN = 0.5 / 1_000_000;

/** Smallest completion budget the model will accept without erroring. */
const MIN_COMPLETION_TOKENS = 16;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Optional effort pin, e.g. OPENAI_REASONING_EFFORT=high. Unset => API default.
 * Only consulted on tool-free turns — see quirk 4, tools force 'none'.
 */
function effortOverride(): ReasoningEffort | undefined {
  const v = process.env.OPENAI_REASONING_EFFORT?.trim();
  if (!v) return undefined;
  return v as ReasoningEffort;
}

/** Anthropic-shaped tool -> OpenAI function tool. */
function toOpenAITools(tools: WireTool[]): ChatCompletionFunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/**
 * `system` + `systemPreamble` concatenate, preamble last, separated by a blank
 * line. An empty preamble is omitted entirely (no trailing whitespace, so the
 * token count of the no-preamble case is genuinely the baseline).
 */
function joinSystem(system: string, systemPreamble: string): string {
  const a = system ?? "";
  const b = systemPreamble ?? "";
  if (!b.trim()) return a;
  if (!a.trim()) return b;
  return `${a}\n\n${b}`;
}

/** OpenAI hands back `arguments` as a JSON string. Never throw on bad JSON. */
function parseArgs(raw: string | undefined | null): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function toOpenAIMessages(
  system: string,
  systemPreamble: string,
  messages: ChatMessage[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];

  const sys = joinSystem(system, systemPreamble);
  if (sys.trim()) {
    // "developer" is the current name for the system role on reasoning models;
    // "system" is still accepted and identical in token cost (verified), but
    // developer is the documented forward-compatible spelling.
    out.push({ role: "developer", content: sys });
  }

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const toolCalls = m.toolCalls ?? [];
      out.push({
        role: "assistant",
        // `content: null` is only legal when tool_calls carry the turn; an
        // assistant message with neither content nor tool_calls is rejected.
        content: m.text ?? (toolCalls.length ? null : ""),
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args ?? {}),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    // tool_results -> one {role:"tool"} message per result, each keyed by id.
    for (const r of m.results) {
      out.push({
        role: "tool",
        tool_call_id: r.id,
        content: r.isError ? `ERROR: ${r.content}` : r.content,
      });
    }
  }

  return out;
}

function readUsage(usage: OpenAI.Completions.CompletionUsage | undefined): Usage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function normaliseStopReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
  refused: boolean,
): string {
  if (hasToolCalls) return "tool_use";
  if (refused) return "refusal";
  switch (finishReason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return finishReason ?? "end_turn";
  }
}

/** Prompt tokens for a minimal probe request, with or without the tool block. */
async function probePromptTokens(
  tools: WireTool[] | null,
  systemPreamble: string,
): Promise<number> {
  const messages = toOpenAIMessages("", tools ? systemPreamble : "", [
    { role: "user", content: "ping" },
  ]);

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    max_completion_tokens: MIN_COMPLETION_TOKENS,
    reasoning_effort: "none",
    // tool_choice:"none" keeps the probe from spending output tokens on a call.
    // Verified: it does NOT change prompt_tokens versus omitting it.
    ...(tools && tools.length
      ? { tools: toOpenAITools(tools), tool_choice: "none" as const }
      : {}),
  });

  return res.usage?.prompt_tokens ?? 0;
}

export const openaiProvider: Provider = {
  id: "openai",
  model: MODEL,
  priceIn: PRICE_IN_PER_MTOK / 1_000_000,
  priceOut: PRICE_OUT_PER_MTOK / 1_000_000,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const messages = toOpenAIMessages(
      req.system,
      req.systemPreamble,
      req.messages,
    );
    const tools = toOpenAITools(req.tools ?? []);
    // Quirk 4: any tool block on /v1/chat/completions forces effort "none".
    const effort: ReasoningEffort | undefined = tools.length
      ? "none"
      : effortOverride();

    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await client.chat.completions.create({
        model: MODEL,
        messages,
        // NOTE: max_completion_tokens, never max_tokens (quirk 1). No
        // temperature (quirk 2). Budget also covers reasoning tokens.
        max_completion_tokens: Math.max(
          MIN_COMPLETION_TOKENS,
          req.maxTokens || MIN_COMPLETION_TOKENS,
        ),
        ...(tools.length ? { tools } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
      });
    } catch (err: any) {
      // The contract says a refusal must surface as a stopReason, not a throw.
      // OpenAI signals prompt-level policy refusals as 400s, so map those; any
      // other failure (auth, rate limit, network) is a real error and rethrows.
      const code = err?.code ?? err?.error?.code ?? "";
      const type = err?.type ?? err?.error?.type ?? "";
      if (
        err?.status === 400 &&
        (String(code).includes("content_policy") ||
          String(code).includes("content_filter") ||
          String(type).includes("invalid_prompt") ||
          String(code).includes("invalid_prompt"))
      ) {
        return {
          toolCalls: [],
          text: String(err?.message ?? "refused"),
          usage: { promptTokens: 0, outputTokens: 0, cachedTokens: 0 },
          stopReason: "refusal",
        };
      }
      throw err;
    }

    const choice = res.choices?.[0];
    const msg = choice?.message;

    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).flatMap((tc: any) => {
      // Only function tool calls are meaningful here; custom tools are not used.
      if (tc?.type && tc.type !== "function") return [];
      return [
        {
          id: tc.id,
          name: tc.function?.name ?? "",
          args: parseArgs(tc.function?.arguments),
        },
      ];
    });

    const refusal = msg?.refusal ?? null;
    const text = refusal ?? msg?.content ?? "";

    return {
      toolCalls,
      text: typeof text === "string" ? text : "",
      usage: readUsage(res.usage),
      stopReason: normaliseStopReason(
        choice?.finish_reason,
        toolCalls.length > 0,
        refusal != null,
      ),
    };
  },

  /**
   * No token-counting endpoint exists for Chat Completions, so measure by
   * difference: two tiny requests, one carrying tools + preamble and one bare,
   * subtracting the reported prompt tokens. Costs a few hundred input tokens.
   */
  async measureToolBlock(
    tools: WireTool[],
    systemPreamble: string,
  ): Promise<number> {
    const [withTools, without] = await Promise.all([
      probePromptTokens(tools, systemPreamble),
      probePromptTokens(null, ""),
    ]);
    return Math.max(0, withTools - without);
  },
};

export default openaiProvider;
