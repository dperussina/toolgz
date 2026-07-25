/**
 * xAI (Grok) provider adapter.
 *
 * xAI serves an OpenAI-compatible Chat Completions API at https://api.x.ai/v1,
 * so we drive it with the `openai` npm client and a swapped baseURL.
 *
 * Model selection was done at build time by querying `client.models.list()`
 * against the live xAI endpoint (not from memory). See the deviations block
 * below for the ways xAI's "OpenAI-compatible" surface is not, in fact,
 * identical to OpenAI's.
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

const BASE_URL = "https://api.x.ai/v1";

/**
 * Chosen from a live `models.list()` call. `grok-4.5` is xAI's frontier tier:
 * newest `created` timestamp of all text models, highest price tier
 * ($2.00/$6.00 per M vs $1.25/$2.50 for the grok-4.20 / grok-4.3 family), and
 * the model docs.x.ai recommends as "the most intelligent and fastest model
 * we've built". Deliberately NOT grok-build-0.1 / grok-code-fast-1, which is
 * the cheap fast tier.
 */
const MODEL = "grok-4.5";

/**
 * Pricing verified 2026-07-25 against two independent sources that agree:
 *   1. the live models endpoint, which reports prices in hundred-thousandths
 *      of a dollar per million tokens: grok-4.5 => prompt 20000, completion
 *      60000, cached prompt 3000.
 *   2. https://docs.x.ai/docs/models pricing table: $2.00/M input,
 *      $0.30/M cached input, $6.00/M output.
 * Both give $2.00 / $6.00 per million for prompts under the 200k long-context
 * threshold. NOTE: xAI doubles every rate for prompts >= 200,000 tokens
 * ($4.00/$12.00 per M). The benchmark's prompts are far below that threshold,
 * so the short-context rate is the correct one; if you ever bench 200k+
 * prompts these constants understate cost by exactly 2x.
 */
const PRICE_IN_PER_MTOK = 2.0;
const PRICE_OUT_PER_MTOK = 6.0;

/* -------------------------------------------------------------------------
 * xAI deviations from OpenAI compatibility (found empirically, 2026-07-25,
 * by diffing raw `chat.completions.create` responses from api.x.ai)
 * -------------------------------------------------------------------------
 * 1. THE IMPORTANT ONE: `usage.completion_tokens` EXCLUDES reasoning tokens.
 *    OpenAI includes reasoning tokens in `completion_tokens`; xAI reports them
 *    separately in `usage.completion_tokens_details.reasoning_tokens` and adds
 *    them on top (`total_tokens == prompt_tokens + completion_tokens +
 *    reasoning_tokens`). grok-4.5 reasons by default, so `completion_tokens`
 *    alone badly under-reports billed output -- observed 12 completion vs 21
 *    reasoning on a single tool call. We therefore report
 *    `outputTokens = completion_tokens + reasoning_tokens`, which matches what
 *    xAI actually bills (verified below) and matches how the Anthropic/OpenAI
 *    adapters count thinking/reasoning output.
 *      Verified against xAI's own `usage.cost_in_usd_ticks` (1 tick = 1e-10
 *      USD, another non-OpenAI field): for prompt 299 / cached 128 /
 *      completion 12 / reasoning 21, xAI billed 5_784_000 ticks =
 *      (299-128)*$2/M + 128*$0.30/M + (12+21)*$6/M = $0.0005784 exactly.
 *      Using completion_tokens alone does not reconcile.
 * 2. `message.reasoning_content` is an extra field carrying the chain of
 *    thought. On a tool-call turn `content` is "" while `reasoning_content`
 *    holds text. We deliberately drop it: `ChatResult.text` is the visible
 *    answer, not the trace.
 * 3. `usage.prompt_tokens_details` uses xAI's own shape -- `text_tokens`,
 *    `image_tokens`, `audio_tokens`, `cached_tokens`. `cached_tokens` is the
 *    only OpenAI-compatible key. Note the automatic prompt cache appears to
 *    work at a 128-token granularity and reports a non-zero `cached_tokens`
 *    (128) even on a cold minimal prompt, so cachedTokens > 0 is NOT proof of
 *    a meaningful cache hit here. There is no explicit cache-control knob.
 * 4. Extra usage keys OpenAI never sends: `num_sources_used`,
 *    `cost_in_usd_ticks`.
 * 5. `tool_choice: "none"` is NOT free: it injects an extra instruction into
 *    the prompt worth ~13 tokens on top of the tool block. Measuring the tool
 *    block with `"none"` therefore overstates it (265 vs a ground truth of
 *    249 for the same tool set); `"auto"` gives 252. `measureToolBlock` uses
 *    `"auto"` so the probe matches what `chat()` actually sends.
 * 6. `finish_reason` and the assistant-turn shape are OpenAI-faithful, contrary
 *    to what you might expect: xAI does return "tool_calls" on tool-call turns,
 *    and it accepts an assistant tool_calls message with the `content` key
 *    omitted entirely. We still send `content: ""` and still derive
 *    stopReason from the tool calls first, defensively.
 * 7. Both `max_tokens` and `max_completion_tokens` are accepted. We send
 *    `max_tokens` (what the xAI docs use). `max_tokens: 1` is accepted, which
 *    is what makes the measure-by-difference probe cheap.
 * 8. `models.list()` returns non-OpenAI keys per model: `aliases`,
 *    `context_length`, and per-token price fields (in units of 1e-5 USD per
 *    million tokens). `grok-latest` / `grok-4.5-latest` are aliases, not
 *    stable ids, so we pin the concrete id.
 * ---------------------------------------------------------------------- */

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: BASE_URL,
});

/** Anthropic-shaped tool defs -> OpenAI function tools. */
function toOpenAITools(tools: WireTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/** `system` + `systemPreamble`, blank line between. Preamble omitted if empty. */
function buildSystemText(system: string, systemPreamble: string): string {
  const a = (system ?? "").trim();
  const b = (systemPreamble ?? "").trim();
  if (a && b) return `${a}\n\n${b}`;
  return a || b;
}

function toOpenAIMessages(
  system: string,
  systemPreamble: string,
  messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  const sys = buildSystemText(system, systemPreamble);
  if (sys) out.push({ role: "system", content: sys });

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        // Deviation 6: xAI tolerates a missing key, but send a string anyway.
        content: m.text ?? "",
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.args ?? {}),
          },
        })),
      });
      continue;
    }
    // tool_results -> one {role:"tool"} message per result.
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

/** `arguments` is a JSON string on the wire; never throw on bad JSON. */
function parseArgs(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractToolCalls(message: any): ToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const tc of raw) {
    // Guard against the newer "custom" tool-call variant in the OpenAI types.
    if (tc?.type && tc.type !== "function") continue;
    if (!tc?.function) continue;
    calls.push({
      id: String(tc.id ?? ""),
      name: String(tc.function.name ?? ""),
      args: parseArgs(tc.function.arguments),
    });
  }
  return calls;
}

function extractUsage(usage: any): Usage {
  const completion = usage?.completion_tokens ?? 0;
  // Deviation 1: reasoning tokens are billed as output but reported outside
  // completion_tokens, so add them back in.
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    outputTokens: completion + reasoning,
    // Deviation 3: xAI reports the cached slice here; 0 when it does not.
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function normaliseStopReason(
  finishReason: string | null | undefined,
  toolCalls: ToolCall[],
  refusal: string | null | undefined,
): string {
  // Tool calls win regardless of what finish_reason says (see deviation 6).
  if (toolCalls.length > 0) return "tool_use";
  if (refusal) return "refusal";
  switch (finishReason) {
    case "tool_calls":
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

export const xaiProvider: Provider = {
  id: "xai",
  model: MODEL,
  priceIn: PRICE_IN_PER_MTOK / 1_000_000,
  priceOut: PRICE_OUT_PER_MTOK / 1_000_000,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const tools = toOpenAITools(req.tools);
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: req.maxTokens,
      messages: toOpenAIMessages(req.system, req.systemPreamble, req.messages),
      ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
    });

    const choice = resp.choices?.[0];
    const message: any = choice?.message ?? {};
    const toolCalls = extractToolCalls(message);
    const refusal: string | null | undefined = message.refusal;

    return {
      toolCalls,
      text: typeof message.content === "string" ? message.content : (refusal ?? ""),
      usage: extractUsage(resp.usage),
      stopReason: normaliseStopReason(choice?.finish_reason, toolCalls, refusal),
    };
  },

  /**
   * No token-counting endpoint on xAI, so measure by difference: the same
   * minimal request with tools + preamble minus the one without, using the
   * server-reported prompt token counts. Two cheap calls (max_tokens: 1).
   *
   * Uses tool_choice "auto", exactly as chat() does -- see deviation 5, using
   * "none" would silently add ~13 tokens of steering text to the measurement.
   * The residual error is ~3 tokens (the system-message envelope, which the
   * no-preamble control does not pay); measured 252 against a ground truth of
   * 249 for a 3-tool block.
   */
  async measureToolBlock(tools: WireTool[], systemPreamble: string): Promise<number> {
    const probe = "x";
    const baseArgs = {
      model: MODEL,
      max_tokens: 1,
    } as const;

    const withTools = await client.chat.completions.create({
      ...baseArgs,
      messages: toOpenAIMessages("", systemPreamble, [{ role: "user", content: probe }]),
      ...(tools.length
        ? { tools: toOpenAITools(tools), tool_choice: "auto" as const }
        : {}),
    });

    const withoutTools = await client.chat.completions.create({
      ...baseArgs,
      messages: toOpenAIMessages("", "", [{ role: "user", content: probe }]),
    });

    const diff =
      (withTools.usage?.prompt_tokens ?? 0) - (withoutTools.usage?.prompt_tokens ?? 0);
    return Math.max(0, diff);
  },
};

export default xaiProvider;
